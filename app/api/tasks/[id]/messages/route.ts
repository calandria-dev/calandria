import fs from "node:fs";
import { getTask, getProject, updateTask, addMessage, listMessages, listPendingMessages, addPendingMessage, getTaskDeps } from "@/lib/store";
import { startTurn, startResumeTurn, sendToLingeringTurn } from "@/lib/runner";
// The sweep this turn's tool calls may need, passed to the runner instead of
// imported by the driver; see AUTO_START_HOOKS. Imported statically since
// lib/autoStart has no static path to an agent SDK, so it can't make this
// route entry async.
import { AUTO_START_HOOKS, blocks } from "@/lib/autoStart";
import { claimTurn, hasTurn, isClearing, unregisterTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { subscribe, publish } from "@/lib/events";
import { ensureWorktree } from "@/lib/git";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { recordBaseCut } from "@/lib/baseDrift";
import { MAX_MESSAGE_CHARS } from "@/lib/promptLimits";
import { worktreePrepNotice } from "@/lib/worktreeFailure";
import { INITIAL_TASK_PROMPT } from "@/lib/agents/shared";
import type { TaskStreamEvent } from "@/lib/types";

const TOO_LARGE = `Message too large (over ${Math.floor(MAX_MESSAGE_CHARS / 1024)} KB). Paste big text as an attachment instead. It'll be saved as a file and read on demand, keeping it out of the prompt.`;

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Starts a turn. The turn runs in a detached server-side runner
 * (lib/runner.ts), and this returns as soon as it's launched, so a page
 * reload, laptop sleep, or dropped connection never kills a running turn.
 * Watch it via GET on this same route (SSE); stop it via /abort.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  const project = getProject(task.project_id);
  if (!project) return new Response(JSON.stringify({ error: "no project" }), { status: 400 });
  if (!project.repo_path.trim()) {
    return new Response(
      JSON.stringify({ error: "Set this project's working directory (⚙ project context) before starting a task." }),
      { status: 400 }
    );
  }
  const { text } = await req.json();

  // Atomically claims the task's turn slot. The in-process abort registry
  // is the liveness source of truth, since task.running can be stale after a
  // crash. claimTurn is a synchronous check-and-register: null means a turn
  // is already streaming, so the follow-up is parked instead of rejected. It
  // renders as "queued" and the runner dequeues it as the next turn when the
  // current one ends. A controller means this request owns the launch: any
  // concurrent POST from here on sees the claim and queues, closing a
  // check-then-start race that could otherwise start two turns on one
  // session, with Stop only able to reach the second.
  const controller = claimTurn(id);
  if (!controller) {
    const content = String(text ?? "").trim();
    if (!content) return new Response(JSON.stringify({ error: "empty message" }), { status: 400 });
    if (content.length > MAX_MESSAGE_CHARS) return new Response(JSON.stringify({ error: TOO_LARGE }), { status: 413 });
    // "A turn is live" isn't one state. A turn lingering on background work
    // (or a scheduled wakeup) has no model running and still holds an open
    // input into the agent session, so the message can go in now and start
    // the next turn instead of waiting behind a linger that is unbounded by
    // default. Anything else, such as a turn mid-thought or an agent whose
    // driver has no input channel, refuses and falls through to the queue.
    if (sendToLingeringTurn(id, content)) {
      return new Response(JSON.stringify({ ok: true, sent: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }
    const pm = addPendingMessage(id, task.generation, content);
    publish(id, { type: "queued", msgId: pm.id, content, generation: task.generation, ts: pm.created_at });
    return new Response(JSON.stringify({ ok: true, queued: true }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  }
  let launched = false;
  try {
    // Ensures the working directory exists, since Claude can't launch with a
    // missing cwd. Creating it supports greenfield projects: a brand-new app
    // in a fresh folder.
    try {
      fs.mkdirSync(project.repo_path, { recursive: true });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `Can't use working directory ${project.repo_path}: ${err instanceof Error ? err.message : String(err)}` }),
        { status: 400 }
      );
    }

    // The launch runs under the per-task lock shared with the merge/sync/
    // complete routes. Those routes rewrite the worktree with multi-second
    // git operations, and a turn starting mid-commit would hand the agent a
    // worktree being staged, and hand the merge the agent's half-written
    // files. The turn slot is already held (the claim above), so a merge
    // that was waiting on it sees hasTurn() and 409s; a merge that held the
    // lock first finishes its commit before the launch proceeds. Awaited so
    // the finally below can't release the claim early.
    return await withTaskLock(id, async () => {
      // Re-reads under the lock, since the task may have moved while this
      // request waited (a merge advancing base_sha, a /clear bumping the
      // generation, a delete). No hasTurn re-check is needed here: the claim
      // above owns the slot atomically, so no other turn can have launched
      // in the meantime. A /clear is the one thing that can take the slot
      // back; see the isClearing guard below.
      const fresh = getTask(id);
      if (!fresh) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      // Covers a re-parent too (POST /move, unstarted tasks only): re-reads
      // the owning project so the worktree below is cut from the repo this
      // task belongs to now, not the one it was filed under when the
      // request landed.
      const proj = fresh.project_id === project.id ? project : getProject(fresh.project_id);
      if (!proj || !proj.repo_path.trim()) return new Response(JSON.stringify({ error: "no project" }), { status: 400 });
      // The up-front mkdir covered the project read earlier, not this one.
      if (proj.id !== project.id) {
        try {
          fs.mkdirSync(proj.repo_path, { recursive: true });
        } catch (err) {
          return new Response(
            JSON.stringify({ error: `Can't use working directory ${proj.repo_path}: ${err instanceof Error ? err.message : String(err)}` }),
            { status: 400 }
          );
        }
      }

      const isInitial = !fresh.started;
      // Dependencies gate whether a task may start. This checks the same
      // predicate the other launchers use, re-read here under the lock so a
      // blocker that finished while this request waited unblocks the start
      // instead of 409ing it.
      //
      // First turn only: once a session is open, blockers are inert, since
      // they order starts. That is also why update_task refuses
      // `blocked_by` on the caller's own started row; gating follow-ups
      // would strand a live conversation the moment someone added a blocker
      // to it.
      if (isInitial) {
        const blockerIds = getTaskDeps(fresh.id).filter(blocks);
        if (blockerIds.length) {
          // Worded like the start screen's own "Blocked until…" notice, so a
          // stale tab's 409 reads the same as the disabled button it missed.
          // `blockedBy` carries the ids for a client that wants to resolve
          // fresher titles than this snapshot.
          const titles = blockerIds.map((depId) => getTask(depId)?.title || depId);
          return new Response(
            JSON.stringify({
              error: `Blocked until ${titles.join(", ")} ${titles.length === 1 ? "is" : "are"} done. Edit the task to change its dependencies.`,
              blockedBy: blockerIds,
            }),
            { status: 409 }
          );
        }
      }
      // buildProjectContext() is the canonical source for task title/details;
      // the opening user turn only tells the fresh session to begin that task.
      const userText = isInitial
        ? INITIAL_TASK_PROMPT
        : String(text ?? "").trim();
      if (!userText) return new Response(JSON.stringify({ error: "empty message" }), { status: 400 });
      if (userText.length > MAX_MESSAGE_CHARS) return new Response(JSON.stringify({ error: TOO_LARGE }), { status: 413 });

      // The claim above was taken before this lock, and a /clear landing in
      // that window aborts the live turn, which releases this controller
      // too, since abortTurn drops whatever holds the slot. The claim no
      // longer proves it's safe to launch: the generation `fresh` reports is
      // the one /clear is partway through retiring, and it will be
      // summarized away and reset while this turn streams (issue #36). Park
      // the message instead, the same outcome as arriving a moment later and
      // being refused the claim outright.
      if (isClearing(id)) {
        const pm = addPendingMessage(id, fresh.generation, userText);
        publish(id, { type: "queued", msgId: pm.id, content: userText, generation: fresh.generation, ts: pm.created_at });
        return new Response(JSON.stringify({ ok: true, queued: true }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Gives the task its own git worktree and branch so parallel tasks in
      // the same repo never collide. Runs on the first turn, and also
      // self-heals a task whose worktree is missing on disk, such as one
      // reopened after its merged worktree was pruned to reclaim disk.
      // ensureWorktree reattaches to the surviving branch when it still
      // exists, restoring the old work. A non-git or empty repo legitimately
      // returns null and falls back to running directly in repo_path
      // (worktree_path stays ""). Mutates `fresh` so the runner uses the new
      // cwd. Safe to await while holding the claim: a second POST landing in
      // this window queues instead of double-running.
      if (!fresh.worktree_path || !fs.existsSync(fresh.worktree_path)) {
        try {
          const requestedBase = resolveBaseBranch(fresh, proj);
          const wt = await ensureWorktree(proj.repo_path, fresh.id, requestedBase);
          if (wt) {
            fresh.worktree_path = wt.path;
            fresh.work_branch = wt.branch;
            fresh.base_sha = wt.baseSha;
            // Pins the base at the cut: from here the task owns the answer,
            // since base_sha came from that branch (lib/baseBranch.ts). An
            // empty string means the branch didn't exist and the cut fell
            // back to HEAD, which isn't a base to record.
            if (wt.baseBranch) fresh.base_branch = wt.baseBranch;
            updateTask(id, {
              worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha,
              ...(wt.baseBranch ? { base_branch: wt.baseBranch } : {}),
            });
            await recordBaseCut({
              taskId: id,
              repoPath: proj.repo_path,
              requestedBase,
              cutBase: wt.baseBranch,
              projectDefault: proj.branch,
            });
          }
        } catch (err) {
          // ensureWorktree returning null is the legitimate fallback handled
          // above. Throwing means something is actually wrong, such as a
          // stale index.lock, a disk-full git op, or a detached HEAD.
          // Falling back would run this turn in the user's real checkout
          // instead of an isolated worktree, under whatever permission mode
          // the task already carries, so this refuses instead with the same
          // visible 400 every other precondition failure in this route
          // uses. The client's runTurn() already resets `running` and drops
          // the message onto the transcript as a system line on a non-ok
          // response.
          //
          // That line is the only thing the user sees, so it carries the
          // classification too (lib/worktreeFailure.ts): what went wrong,
          // and, for a stale lock or a stale registration, the notice the
          // transcript turns into a "Repair worktree" button. Marked with
          // the same ⚠ every runner error line uses so it reads as the
          // failure it is. ensureWorktree raises the "Could not prepare…"
          // wording itself, so the message is identical whichever launch
          // path hit it.
          const detail = err instanceof Error ? err.message : String(err);
          const notice = worktreePrepNotice(detail);
          return new Response(
            JSON.stringify({ error: notice ? `⚠ ${detail}\n\n${notice}` : `⚠ ${detail}` }),
            { status: 400 }
          );
        }
      }

      const gen = fresh.generation;
      if (isInitial) {
        const userMsg = addMessage(id, gen, "user", userText);
        // Marks running immediately, but defers `started` until Claude
        // actually opens a session, so a failed launch leaves the task
        // cleanly retryable.
        updateTask(id, { running: 1, suggested: 0, awaiting_input: 0 });
        // Echoes the user message to every open stream of this task,
        // including the sender: the client renders from events, not
        // optimistically.
        publish(id, { type: "user", content: userMsg.content, msgId: userMsg.id, generation: gen, ts: userMsg.created_at });
        startTurn(fresh, proj, userText, "", controller, undefined, AUTO_START_HOOKS);
      } else {
        // Resume: catches the worktree up, persists and echoes the message,
        // then hands off to the detached runner. Same path the queue
        // drainer uses.
        await startResumeTurn(fresh, proj, userText, controller, AUTO_START_HOOKS);
      }
      // The runner owns the claim now; its finally releases (or hands off) the slot.
      launched = true;
      return new Response(JSON.stringify({ ok: true, generation: gen }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    });
  } finally {
    // Every non-launch exit (bad working dir, missing task, empty or
    // oversized message, a throw before the runner took over) must free the
    // claim, or the task would read "running" forever and every future
    // message would queue into the void.
    if (!launched) unregisterTurn(id, controller);
  }
}

/**
 * Watches a task's transcript as SSE: first a `snapshot` event replaying the
 * persisted messages from SQLite, then a live tail of turn events via the
 * in-process bus. Reconnect-safe (each connect re-snapshots, events carry DB
 * message ids so clients upsert) and fan-out-safe (any number of viewers).
 * Closing this stream never touches the turn; Stop is the /abort route.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: TaskStreamEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      // Subscribe before snapshotting; both are synchronous (better-sqlite3),
      // so no event can fall between the snapshot and the tail.
      const unsub = subscribe(id, (ev) => {
        try {
          send(ev);
        } catch {
          cleanup();
        }
      });
      // Keep-alive comment so proxies don't reap quiet streams, and so a dead
      // client is detected (enqueue throws) even when the task is idle.
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
      send({ type: "snapshot", messages: listMessages(id), pending: listPendingMessages(id), running: hasTurn(id) });
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      // Viewer went away (reload, sleep, tab close). Just detaches; the
      // turn, if any, keeps running in lib/runner.ts.
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
