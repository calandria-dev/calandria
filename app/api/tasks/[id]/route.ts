import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, deleteTask, listMessages, getTaskUsage, getTaskContext, getTaskDeps, setTaskDeps, sameDepSet, countAwaiting, getTag, getTaskTagIds, setTaskTags } from "@/lib/store";
import { removeWorktree } from "@/lib/git";
import { removeTaskUploads } from "@/lib/uploads";
import { abortTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { maybeAutoStartDependents } from "@/lib/autoStart";
import { publishGlobal } from "@/lib/events";
import { isAgentId } from "@/lib/agents/capabilities";
import { serializeAgentEnv } from "@/lib/agentEnv";
import { serializeGatewayMcp } from "@/lib/gatewayMcp";
import type { Task } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const usage = getTaskUsage(id);
  const ctx = getTaskContext(id);
  return NextResponse.json({
    ...task,
    cost_usd: usage.cost_usd,
    // Turns whose endpoint had no price, making `cost_usd` a floor. Without it
    // a page load would drop the marker the live stream had already put on the
    // chip, and the total would silently go back to reading as complete.
    unpriced_turns: usage.unpriced_turns,
    total_tokens: usage.total_tokens,
    // The cache buckets travel with the total so the usage chip can split
    // "fresh work" from re-read context instead of showing one inflated number.
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    // Additional to `total_tokens`, not part of it: sidechain spend the four
    // buckets above never counted, so the chip can name it rather than let a
    // fan-out read as this session's own work.
    subagent_tokens: usage.subagent_tokens,
    context_tokens: ctx.context_tokens,
    // 0 = no window we can name, which is what a provider override always
    // means (lib/store.ts taskContextWindow). The rail reads this to show the
    // token count without a percentage rather than a made-up one.
    context_window: ctx.context_window,
    context_pct: ctx.context_pct,
    context_estimated: ctx.context_estimated,
    depends_on: getTaskDeps(id),
    tag_ids: getTaskTagIds(id),
    messages: listMessages(id),
  });
}

// Everything in the whitelist below except `status`: the fields a listener
// CAN'T patch from the coarse /api/events payload, which only carries
// running/awaiting_input/status. A change to any of them has to be announced as
// `task_edited` ("refetch the row") rather than `task_updated` ("here's the new
// status") — see lib/events.ts.
const EDIT_FIELDS = ["title", "description", "priority", "suggested", "agent", "model", "reasoning", "permission_mode", "auto_start", "send_context", "agent_env", "gateway_mcp", "withdrawn_reason", "snoozed_until", "start_at"] as const;

// Terminal = no longer blocking anything, the same pair lib/autoStart's blocks()
// uses. A dependent waiting on a CANCELLED blocker would wait forever, so
// cancelling clears the edge exactly as finishing does.
const isTerminal = (s: string) => s === "done" || s === "cancelled";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as Partial<Task>;
  const current = getTask(id);
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });
  const prevStatus = current.status;
  // Whitelist user-editable fields.
  const allowed: Partial<Task> = {};
  for (const k of ["title", "description", "priority", "status", "suggested", "model", "reasoning", "permission_mode", "auto_start", "send_context"] as const) {
    if (k in body) (allowed as Record<string, unknown>)[k] = body[k];
  }
  // `model` is the one whitelisted field with an open-ended value: the picker
  // offers a catalog, but the column takes whatever a client sends and the
  // driver passes it to the CLI, so the route is the only place that can say
  // what a model id may LOOK like. Kept deliberately permissive about content
  // (provider-native ids and inference-profile ARNs are the driver's business,
  // not this route's) and strict about shape — a control character would reach
  // a spawned process and the transcript, and an unbounded string has no
  // legitimate form. An empty/blank string means "inherit", which the rest of
  // the app spells `null`.
  if ("model" in body) {
    if (body.model !== null && typeof body.model !== "string")
      return NextResponse.json({ error: "model must be a string or null" }, { status: 400 });
    if (typeof body.model === "string") {
      const model = body.model.trim();
      if (model.length > 2048 || /[\0-\x1f\x7f]/.test(model))
        return NextResponse.json({ error: "invalid model id" }, { status: 400 });
      allowed.model = model || null;
    }
  }
  // Provider override (lib/agentEnv.ts): which endpoint and model this task's
  // turns run against, laid over the project's. Object or JSON text; the
  // allowlist is enforced by the store's serialize, so an unlisted key is
  // dropped rather than stored. Refused only for a shape that can't be read.
  if ("agent_env" in body) {
    const v = (body as { agent_env?: unknown }).agent_env;
    if (v !== null && typeof v !== "string" && (typeof v !== "object" || Array.isArray(v)))
      return NextResponse.json({ error: "agent_env must be an object, JSON text or null" }, { status: 400 });
    allowed.agent_env = serializeAgentEnv(v);
  }
  // Per-task override of the project's hosted-MCP selection
  // (docs/design/litellm.md, "Hosted MCP servers"). null = inherit the
  // project's gateway_mcp; an array or JSON text (including "[]") replaces it
  // outright.
  if ("gateway_mcp" in body) {
    const v = (body as { gateway_mcp?: unknown }).gateway_mcp;
    if (v !== null && !Array.isArray(v) && typeof v !== "string")
      return NextResponse.json({ error: "gateway_mcp must be an array of aliases, JSON text, or null" }, { status: 400 });
    allowed.gateway_mcp = v === null ? null : serializeGatewayMcp(v);
  }
  // Snoozing. Two spellings, because they answer to two different clocks:
  //   - `snoozed_until` is a deadline the USER picked, so it's theirs to state;
  //   - `unsnooze` means "back now", which has to resolve against the SERVER's
  //     clock — the one lib/store's NEEDS_YOU predicate compares against. A
  //     browser running minutes fast that sent its own Date.now() would write a
  //     deadline still in the future and leave the task it just woke hidden
  //     from the pill until the skew elapsed.
  // Validated rather than coerced: the column is a ms epoch and a stray float
  // or NaN would land in SQLite as a value no comparison reads the way the
  // caller meant.
  if ("snoozed_until" in body) {
    const v = body.snoozed_until;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
      return NextResponse.json({ error: "snoozed_until must be a non-negative epoch in milliseconds" }, { status: 400 });
    allowed.snoozed_until = v;
  }
  if ((body as { unsnooze?: unknown }).unsnooze === true) allowed.snoozed_until = Date.now();
  // Tag membership. Validated here rather than trusted: task_tags is a plain
  // FK pair, so a tag from ANOTHER project would be accepted by SQLite and then
  // filter this task out of every view in its own project. `[]` clears every
  // tag. Applied below with the dependency edges, since like them it is a
  // second table rather than a column. (Bulk assignment is its own route; this
  // is the edit dialog's.)
  let nextTagIds: string[] | null = null;
  if ("tag_ids" in body) {
    const raw = (body as { tag_ids?: unknown }).tag_ids;
    if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string"))
      return NextResponse.json({ error: "tag_ids must be an array of tag ids" }, { status: 400 });
    const ids = [...new Set(raw as string[])];
    for (const tagId of ids) {
      const tag = getTag(tagId);
      if (!tag) return NextResponse.json({ error: "no such tag" }, { status: 400 });
      if (tag.project_id !== current.project_id)
        return NextResponse.json({ error: "tag belongs to another project. A tag can't span projects" }, { status: 400 });
    }
    nextTagIds = ids;
  }
  // Queued start (lib/deferredStart.ts): the same shape and the same validation
  // as the snooze deadline — a ms epoch the user picked (the client reads the
  // usage-window reset off the plan meter), 0 to cancel. Past deadlines are
  // accepted rather than refused: they fire on the next sweep, which is what
  // "start it once the reset passes" means when the reset already has.
  if ("start_at" in body) {
    const v = body.start_at;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
      return NextResponse.json({ error: "start_at must be a non-negative epoch in milliseconds" }, { status: 400 });
    if (v > 0 && (current.status === "done" || current.status === "cancelled"))
      return NextResponse.json({ error: "a finished task can't be queued to start" }, { status: 409 });
    allowed.start_at = v;
  }
  if ("agent" in body) {
    if (typeof body.agent !== "string" || !isAgentId(body.agent))
      return NextResponse.json({ error: "valid agent required" }, { status: 400 });
    if (current.started === 1 || current.running === 1)
      return NextResponse.json({ error: "agent cannot change after the task starts" }, { status: 409 });
    if (body.agent !== current.agent) {
      allowed.agent = body.agent;
      // Run controls are provider-specific. An inherited/default choice is safe
      // for the newly selected driver; persisted choices from the old one aren't.
      allowed.model = null;
      allowed.resolved_model = null;
      allowed.reasoning = null;
      allowed.permission_mode = null;
      allowed.session_id = null;
    }
  }
  // A manual status change is the user taking the wheel — clear the "your turn"
  // flag, and with it the ran-clean mark an unattended run left behind. The two
  // go together because they answer the same question ("does this row still
  // want something from you"), and because the mark's ONLY way out is a status
  // write: clearing it on its own would drop the task straight back into the
  // undifferentiated "In progress" pile it was pulled out of (issue #28).
  if ("status" in allowed) {
    allowed.awaiting_input = 0;
    allowed.unread_run_at = 0;
  }
  // Cancelling means "stop working on this": kill any in-flight turn. The
  // runner's finally block settles running=0 and discards the parked queue.
  // (The worktree is kept — Cancelled ≠ Delete — so the diff stays reviewable
  // and the task can be revived by just sending another message.)
  if (allowed.status === "cancelled") abortTurn(id);
  // Reviving a withdrawn suggestion, in one place. A withdrawn row is cancelled
  // but still `suggested` (the withdraw_suggestion agent tool — it stays in the
  // tray so the user can bring it back), and EVERY way back lands on this route:
  // the tray's Start and Add both patch `suggested: 0` and nothing else, the
  // board's drag sends a status alongside, the edit dialog re-statuses in place.
  // Centralised here rather than left to each caller because the two halves have
  // to move together — a reason left behind strikes through a card that's live
  // again, and a status left at `cancelled` files the accepted task straight
  // into the Cancelled column.
  const withdrawn = current.status === "cancelled" && current.suggested === 1;
  if (withdrawn && (("status" in allowed && allowed.status !== "cancelled") || ("suggested" in allowed && !allowed.suggested))) {
    allowed.withdrawn_reason = "";
    if (!("status" in allowed)) allowed.status = "not_started";
  }
  // Dependency edges live in their own table — set them separately, with a cycle guard.
  let depsChanged = false;
  if (Array.isArray((body as { depends_on?: unknown }).depends_on)) {
    const before = getTaskDeps(id);
    try {
      setTaskDeps(id, (body as { depends_on: string[] }).depends_on);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "invalid dependencies" }, { status: 400 });
    }
    // Compared, not assumed: the setter drops unusable refs (cross-project,
    // self, duplicates), so a submitted list is often identical to the stored
    // one — and every edit dialog save submits `depends_on` whether or not the
    // user touched it.
    depsChanged = !sameDepSet(before, getTaskDeps(id));
  }
  // Tags, same shape: their own table, compared rather than assumed, because
  // the edit dialog submits the whole list on every save whether or not the
  // user touched it.
  let tagsChanged = false;
  if (nextTagIds) {
    const before = getTaskTagIds(id);
    tagsChanged = before.length !== nextTagIds.length || before.some((t, i) => t !== nextTagIds![i]);
    if (tagsChanged) setTaskTags([id], nextTagIds);
  }
  const task = updateTask(id, allowed);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Announce the write, or every other tab keeps rendering the old row until it
  // reloads. (The tab that made the edit patched its own state optimistically,
  // which is why this is invisible single-tab.) Two flavours, and the wider one
  // wins when a patch is both: `task_edited` says "refetch", and the listener
  // applies the status/awaiting snapshot riding along with it either way, so a
  // second `task_updated` would only buy a duplicate.
  //   - task_edited: a field the coarse /api/events payload can't carry changed
  //     — a rename, a reprioritisation, a suggestion accepted out of the tray.
  //     Dependency edges count: they change what the tray draws for the
  //     NEIGHBOURING rows too, and a refetch is what redraws them. So do tags,
  //     which move the chip bar's counts as well as this row's badges.
  //   - task_updated: a manual status change settles status + awaiting_input
  //     outside any turn, so no runner publish will follow — without this every
  //     other tab's "needs you" badges keep counting this task. Published on any
  //     status key, even an unchanged one: it also clears awaiting_input, which
  //     is the half the badges actually read.
  // task_edited compares against the pre-write row, so a no-op save from the
  // edit dialog (which submits every field whether or not it was touched) stays
  // silent instead of making every tab refetch its tray.
  const edited = depsChanged || tagsChanged || EDIT_FIELDS.some((k) => k in allowed && allowed[k] !== current[k]);
  if (edited) publishGlobal(id, { type: "task_edited" });
  else if ("status" in allowed) publishGlobal(id, { type: "task_updated" });
  // A tag write moves the chip bar's derived counts as well as this row, and
  // `task_edited` only says "refetch this task". Same event the bulk route and
  // the tag CRUD routes publish, so every surface reading a count refreshes
  // from one read.
  if (tagsChanged) publishGlobal("", { type: "tags_changed", projectId: current.project_id });
  // The sweep that honours a queued start is started by the boot ping; make
  // sure of it here too, so a deadline set on an instance whose ping was lost
  // still fires. Idempotent. Dynamic for the reason on /api/instance/scheduler:
  // the module reaches the runner and must not be linked statically from here.
  if (task.start_at > 0) void import("@/lib/deferredStart").then((m) => m.startDeferredStartTicker());
  // Reaching a TERMINAL status may have cleared the last blocker some auto-start
  // dependent was waiting on. done and cancelled both count, because both are
  // what lib/autoStart's blocks() calls cleared — firing only on done left a
  // cancelled blocker's dependents unblocked but never launched, waiting on a
  // sweep that would never come. Fire-and-forget: the launch runs detached
  // (worktree creation can take seconds) and must never delay or fail this
  // status change.
  if (isTerminal(task.status) && !isTerminal(prevStatus)) maybeAutoStartDependents(id);
  return NextResponse.json({ ...task, depends_on: getTaskDeps(id) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Under the same per-task lock the merge/sync/turn-launch paths hold: those
  // re-read the task and then INSERT rows keyed on it (task_merges, messages),
  // so a delete landing between their re-read and their insert throws FOREIGN
  // KEY out of a route that already validated the row. Serializing here closes
  // that window; the cascade then removes whatever they committed first.
  await withTaskLock(id, async () => {
    const task = getTask(id);
    // Stop any in-flight turn before tearing down its worktree, so the runner
    // isn't mid-write when the directory disappears.
    abortTurn(id);
    if (task?.worktree_path) {
      const project = getProject(task.project_id);
      if (project?.repo_path) await removeWorktree(project.repo_path, task.worktree_path, task.work_branch);
    }
    removeTaskUploads(id);
    deleteTask(id);
    // Publish AFTER the hard delete, carrying the project id + its recomputed
    // awaiting count: the row is gone, so /api/events' usual re-read-the-task
    // enrichment would drop the event and freeze the project's badge in every
    // other tab until the next SSE reconnect.
    if (task) publishGlobal(id, { type: "task_deleted", projectId: task.project_id, awaiting_count: countAwaiting(task.project_id) });
  });
  return NextResponse.json({ ok: true });
}
