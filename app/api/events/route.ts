import { getTask, countAwaiting } from "@/lib/store";
import { subscribeGlobal, type BusEvent, type GlobalTaskWireEvent, type GlobalWireEvent } from "@/lib/events";
import { ensureNotifier } from "@/lib/notifications/dispatcher";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Which raw bus events mark a coarse lifecycle boundary. Everything else
// (assistant text, tool calls, usage, …) is per-transcript detail that only
// the task's own /messages stream cares about.
//
// `user` fires the moment a turn launches (running=1 is already persisted);
// `session` re-fires turn_started once the agent session actually opens,
// because that's when status flips to in_progress. Both map to the same
// coarse event — the payload is a snapshot, so replays are idempotent.
// `task_updated` is a mutation route (status PATCH, /clear) settling the row
// with no turn involved; same snapshot payload, same idempotence.
function coarse(ev: BusEvent): GlobalTaskWireEvent["event"] | null {
  switch (ev.type) {
    case "user":
    case "session":
      return "turn_started";
    // Both kinds of "your turn" park the task the same way: a question card
    // and a tool-permission prompt each set awaiting_input and each clear it.
    case "ask":
    case "permission":
      return "awaiting_input";
    case "ask_answered":
    case "permission_decided":
      return "ask_answered";
    case "suggested":
      return "suggested";
    // The linger boundary, both directions: entering "working in background"
    // and waking from it. One coarse name — the payload is a snapshot and
    // background_pending on the re-read row says which side this is.
    case "background_pending":
    case "background_resumed":
      return "background";
    case "turn_end":
      return "turn_end";
    case "task_updated":
      return "task_updated";
    // A write rewrote the row's title/description/priority/dependencies too —
    // the user's edit dialog (PATCH /api/tasks/[id]) or the `update_task` agent
    // tool. The payload below can't carry those, so the client refetches on it.
    case "task_edited":
      return "task_edited";
    default:
      return null;
  }
}

/**
 * The global task-lifecycle stream: one always-open SSE connection per client
 * tab, broadcasting coarse turn boundaries for EVERY task across EVERY project
 * — turn started, parked on a question, question answered, suggestion created,
 * turn ended, plus the route-published mutations (status PATCH / /clear settles,
 * task deletion). It's what keeps the task list's spinners, the project rail's
 * "needs you" badges, and the titlebar pill live for tasks whose transcript
 * stream isn't open (only the SELECTED task has one), replacing the old
 * 10-second task-list poll.
 *
 * Each event is built by re-reading the task row at publish time: the runner
 * persists running/awaiting_input/status BEFORE it publishes, so the snapshot
 * the client applies is authoritative, and replays/reconnect overlaps are
 * idempotent. There is deliberately no snapshot-on-connect — the client owns
 * its lists via the REST endpoints and refetches them on reconnect (events
 * missed while disconnected are gone; this stream is a live tail only).
 */
export async function GET(req: Request) {
  // The bus subscriber that mints notifications. Idempotent, so every tab's
  // stream calls it and only the first one subscribes. Here rather than at boot
  // because this stream IS the only channel today: a notification published
  // with no tab open has nowhere to go.
  ensureNotifier();
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: GlobalWireEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const unsub = subscribeGlobal((taskId, ev) => {
        // An agent's login died (or started working again). Task-keyed on the bus
        // because that's where it was detected, but instance-wide in meaning —
        // one login per agent, shared by every task — so it relays verbatim and
        // every tab raises/drops the reconnect banner at once.
        if (ev.type === "agent_auth") {
          send({ type: "agent_auth", agent: ev.agent, broken: ev.broken, reason: ev.reason });
          return;
        }
        // A task row was hard-deleted. There is nothing left to re-read — the
        // event carries its own project id + recomputed awaiting count — and
        // the getTask bail below would otherwise drop it, freezing the
        // project's badge in other tabs until the next SSE reconnect.
        if (ev.type === "task_deleted") {
          send({ type: "task_deleted", taskId, projectId: ev.projectId, awaiting_count: ev.awaiting_count });
          return;
        }
        // Tasks were re-parented. The rows still exist, but re-reading them can
        // only say where they landed — the projects they LEFT have to drop them
        // from their trays, so both ends travel with the event. Relayed whole:
        // the bus key is one arbitrary member of the set, so `taskId` is
        // deliberately ignored here.
        if (ev.type === "tasks_moved") {
          send({ type: "tasks_moved", taskIds: ev.taskIds, fromProjectIds: ev.fromProjectIds, toProjectId: ev.toProjectId });
          return;
        }
        // A board drop rewrote the project's manual order. Project-keyed, so it
        // bypasses the getTask re-read below the same way task_deleted does:
        // the bus key is one arbitrary member of the reordered set (`taskId` is
        // ignored here), and the row snapshot has nothing to say about order —
        // `position` isn't even on the wire payload.
        if (ev.type === "tasks_reordered") {
          send({ type: "tasks_reordered", projectId: ev.projectId });
          return;
        }
        // A project's saved runbooks changed — a create/edit/copy/delete here,
        // in another tab, or an agent's create_runbook. Bypasses the getTask
        // re-read below for a stronger reason than the branches above: there is
        // no task row in this mutation at all, so its publishers key the bus
        // with "" and `taskId` is meaningless here.
        if (ev.type === "runbooks_changed") {
          send({ type: "runbooks_changed", projectId: ev.projectId });
          return;
        }
        // A composed notification (lib/notifications/notify.ts). Bypasses the
        // re-read below for the strongest reason of all these branches: the
        // payload isn't a fact to look up but a message already written for a
        // human, screened against the row when it was minted — and a test
        // notification names no task at all, so the getTask bail would drop it.
        if (ev.type === "notification") {
          send({ type: "notification", payload: ev.payload });
          return;
        }
        const event = coarse(ev);
        if (!event) return;
        // Task deleted mid-turn (rows are hard-deleted) — nothing to report;
        // the DELETE route's own task_deleted publish (above) covers cleanup.
        const t = getTask(taskId);
        if (!t) return;
        const payload: GlobalTaskWireEvent = {
          type: "task",
          event,
          taskId,
          projectId: t.project_id,
          running: !!t.running,
          awaiting_input: !!t.awaiting_input,
          background_pending: !!t.background_pending,
          background_note: t.background_note ?? "",
          status: t.status,
          awaiting_count: countAwaiting(t.project_id),
          // A suggestion can be filed into a project other than the one the
          // turn runs in, and then every field above describes the WRONG
          // project as far as the tray is concerned. Carry the target too.
          ...(ev.type === "suggested" ? { suggestedProjectId: ev.projectId } : {}),
        };
        send(payload);
      });
      // Keep-alive comment so proxies don't reap quiet streams, and so a dead
      // client is detected (enqueue throws) even when nothing is running.
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 25_000);
      let done = false;
      cleanup = () => {
        if (done) return;
        done = true;
        unsub();
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      // Open the stream promptly so EventSource fires onopen (the client's
      // reconnect-resync hook) without waiting for the first real event.
      controller.enqueue(encoder.encode(`: connected\n\n`));
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
