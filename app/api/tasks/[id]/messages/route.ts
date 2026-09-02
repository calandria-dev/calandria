import fs from "node:fs";
import { getTask, getProject, updateTask, addMessage, listMessages, listPendingMessages, addPendingMessage, getTaskDeps } from "@/lib/store";
import { startTurn, startResumeTurn, sendToLingeringTurn } from "@/lib/runner";
// The sweep this turn's tool calls may need, handed to the runner rather than
// imported by the driver — see AUTO_START_HOOKS. Static import: lib/autoStart
// has no static path to an agent SDK, so it can't make this route entry async.
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
 * Start a turn. The turn itself runs in a detached server-side runner
 * (lib/runner.ts) — this returns as soon as it's launched, so a page reload,
 * laptop sleep, or dropped connection never kills a running turn. Watch it via
 * GET on this same route (SSE), stop it explicitly via /abort.
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

  // Atomically claim the task's turn slot (the in-process abort registry is
  // the liveness source of truth — task.running can be stale after a crash).
  // claimTurn is a synchronous check+register: null means a turn is already
  // streaming, so park the follow-up instead of rejecting it — it renders as
  // "queued" and the runner dequeues it as the next turn when the current one
  // ends. A controller means WE own the launch: any concurrent POST from here
  // on sees the claim and queues, closing the old check-then-start race (two
  // turns on one session, with Stop only able to reach the second).
  const controller = claimTurn(id);
  if (!controller) {
    const content = String(text ?? "").trim();
    if (!content) return new Response(JSON.stringify({ error: "empty message" }), { status: 400 });
    if (content.length > MAX_MESSAGE_CHARS) return new Response(JSON.stringify({ error: TOO_LARGE }), { status: 413 });
    // "A turn is live" isn't one state. A turn LINGERING on background work (or
    // a scheduled wakeup) has no model running and still holds an open input
    // into the agent session, so the message can go in now and start the next
    // turn rather than waiting behind a linger that is unbounded by default.
    // Anything else — a turn mid-thought, an agent whose driver has no input
    // channel — refuses, and falls through to the queue exactly as before.
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
    // Ensure the working directory exists — Claude can't launch with a missing cwd.
    // Creating it supports greenfield projects (a brand-new app in a fresh folder).
    try {
      fs.mkdirSync(project.repo_path, { recursive: true });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `Can't use working directory ${project.repo_path}: ${err instanceof Error ? err.message : String(err)}` }),
        { status: 400 }
      );
    }

    // The launch runs under the per-task lock shared with the merge/sync/complete
    // routes: those rewrite the worktree with multi-second git operations, and a
    // turn starting mid-commit would hand the agent a worktree being staged (and
    // hand the merge the agent's half-written files). We already hold the turn
    // slot (the claim above), so a merge that was waiting on us sees hasTurn()
    // and 409s; a merge that held the lock first finishes its commit before we
    // launch. `await` so the finally below can't release the claim early.
    return await withTaskLock(id, async () => {
      // Re-read under the lock — the task may have moved while we waited (a
      // merge advancing base_sha, a /clear bumping the generation, a delete).
      // No hasTurn re-check is needed here: the claim above owns the slot
      // atomically, so no other turn can have launched in the meantime. A
      // /clear is the one thing that can take the slot back out from under us —
      // see the isClearing guard below.
      const fresh = getTask(id);
      if (!fresh) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      // Including a re-parent (POST /move, unstarted tasks only): re-read the
      // owning project so the worktree below is cut from the repo this task
      // belongs to NOW, not the one it was filed under when the request landed.
      const proj = fresh.project_id === project.id ? project : getProject(fresh.project_id);
      if (!proj || !proj.repo_path.trim()) return new Response(JSON.stringify({ error: "no project" }), { status: 400 });
      // The up-front mkdir covered the project we read then, not this one.
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
      // Dependencies gate whether a task may START, and until now this — the
      // manual path — was the one launcher that didn't check. The block was
      // enforced by whichever client happened to render the Start button, so a
      // second tab with a stale list, a curl, or the suggestion Start in the
      // tray/board/transcript (which never checked at all) launched a blocked
      // task without complaint, while the two unattended launchers refused.
      // Same predicate they use, not a fourth copy of it, and re-read here
      // under the lock so a blocker that finished while this request waited
      // unblocks the start rather than 409ing it.
      //
      // First turn ONLY. Once a session is open the blockers are inert: they
      // order *starts*, which is the same reason update_task refuses
      // `blocked_by` on the caller's own started row. Gating follow-ups would
      // strand a live conversation the moment someone added a blocker to it.
      if (isInitial) {
        const blockerIds = getTaskDeps(fresh.id).filter(blocks);
        if (blockerIds.length) {
          // Worded as the start screen's own "Blocked until …" notice, so the
          // 409 a stale tab gets reads the same as the disabled button it
          // missed. `blockedBy` carries the ids for a client that wants to
          // resolve fresher titles than this snapshot.
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

      // The claim above was taken before this lock, and a /clear landing in that
      // window aborts the live turn — which releases OUR controller too, since
      // abortTurn drops whatever holds the slot. So the claim no longer proves
      // it's safe to launch: the generation `fresh` reports is the one /clear is
      // partway through retiring, and it will be summarized away and reset while
      // this turn streams (issue #36). Park the message, the same outcome as
      // arriving a moment later and being refused the claim outright.
      if (isClearing(id)) {
        const pm = addPendingMessage(id, fresh.generation, userText);
        publish(id, { type: "queued", msgId: pm.id, content: userText, generation: fresh.generation, ts: pm.created_at });
        return new Response(JSON.stringify({ ok: true, queued: true }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Give the task its own git worktree + branch so parallel tasks in the same
      // repo never collide. This runs on the first turn, but also self-heals a task
      // whose worktree is missing on disk — e.g. one that was reopened after its
      // merged worktree was pruned to reclaim disk. ensureWorktree reattaches to the
      // surviving branch when it still exists, so the old work is restored. Non-git/
      // empty repos legitimately return null and fall back to running directly in
      // repo_path (worktree_path stays ""). Mutating `fresh` so the runner uses the
      // new cwd. Safe to await while holding the claim: that's the point — a second
      // POST landing in this window queues instead of double-running.
      if (!fresh.worktree_path || !fs.existsSync(fresh.worktree_path)) {
        try {
          const requestedBase = resolveBaseBranch(fresh, proj);
          const wt = await ensureWorktree(proj.repo_path, fresh.id, requestedBase);
          if (wt) {
            fresh.worktree_path = wt.path;
            fresh.work_branch = wt.branch;
            fresh.base_sha = wt.baseSha;
            // Pin the base at the cut: from here the task owns the answer, because
            // base_sha came from that branch (lib/baseBranch.ts). "" = the branch
            // didn't exist and the cut fell back to HEAD, which isn't a base to
            // record.
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
          // above. THROWING means something is actually wrong (a stale
          // index.lock, a disk-full git op, a detached HEAD) — falling back
          // silently would run this turn in the user's real checkout instead
          // of an isolated worktree, under whatever permission mode the task
          // already carries. Refuse with the same visible 400 every other
          // precondition failure in this route uses: the client's runTurn()
          // already resets `running` and drops the message onto the
          // transcript as a system line on a non-ok response.
          //
          // That line is the only thing the user sees, so it carries the
          // classification too (lib/worktreeFailure.ts): what went wrong, and
          // — for a stale lock or a stale registration — the notice the
          // transcript turns into a "Repair worktree" button. Marked with the
          // same ⚠ every runner error line uses so it reads as the failure it
          // is. ensureWorktree raises the "Could not prepare…" wording itself,
          // so the message is identical whichever launch path hit it.
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
        // Mark running immediately, but defer `started` until Claude actually opens
        // a session — so a failed launch leaves the task cleanly retryable.
        updateTask(id, { running: 1, suggested: 0, awaiting_input: 0 });
        // Echo the user message to every open stream of this task (other viewers,
        // and the sender itself — the client renders from events, not optimistically).
        publish(id, { type: "user", content: userMsg.content, msgId: userMsg.id, generation: gen, ts: userMsg.created_at });
        startTurn(fresh, proj, userText, "", controller, undefined, AUTO_START_HOOKS);
      } else {
        // Resume: catch the worktree up, persist + echo the message, then hand off
        // to the detached runner. Same path the queue drainer uses.
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
    // Every non-launch exit (bad working dir, missing task, empty/oversized
    // message, a throw before the runner took over) must free the claim, or the
    // task would read "running" forever and every future message would queue
    // into the void.
    if (!launched) unregisterTurn(id, controller);
  }
}

/**
 * Watch a task's transcript as SSE: first a `snapshot` event replaying the
 * persisted messages from SQLite, then a live tail of turn events via the
 * in-process bus. Reconnect-safe (each connect re-snapshots, events carry DB
 * message ids so clients upsert) and fan-out-safe (any number of viewers).
 * Closing this stream never touches the turn — Stop is the /abort route.
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
      // Viewer went away (reload, sleep, tab close). Just detach — the turn,
      // if any, keeps running in lib/runner.ts.
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
