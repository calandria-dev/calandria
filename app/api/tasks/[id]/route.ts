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
    // Turns whose endpoint had no price, so cost_usd is only a floor.
    // Preserves the marker the live stream already set on the chip after a
    // page load.
    unpriced_turns: usage.unpriced_turns,
    total_tokens: usage.total_tokens,
    // Cache buckets travel with the total so the usage chip can show fresh
    // work separately from re-read context.
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    // Sidechain spend, on top of total_tokens and not counted in it, so the
    // chip can label it separately from this session's own work.
    subagent_tokens: usage.subagent_tokens,
    context_tokens: ctx.context_tokens,
    // 0 means no known context window, which is what a provider override
    // always implies (lib/store.ts taskContextWindow). The rail then shows
    // the raw token count instead of a percentage.
    context_window: ctx.context_window,
    context_pct: ctx.context_pct,
    context_estimated: ctx.context_estimated,
    depends_on: getTaskDeps(id),
    tag_ids: getTaskTagIds(id),
    messages: listMessages(id),
  });
}

// Fields (besides status) that the coarse /api/events payload can't carry,
// since it only carries running/awaiting_input/status. A change to any of
// these publishes `task_edited` ("refetch the row") instead of
// `task_updated` ("here's the new status"); see lib/events.ts.
const EDIT_FIELDS = ["title", "description", "priority", "suggested", "agent", "model", "reasoning", "permission_mode", "auto_start", "send_context", "agent_env", "gateway_mcp", "withdrawn_reason", "snoozed_until", "start_at"] as const;

// Terminal statuses no longer block anything, matching the pair
// lib/autoStart's blocks() uses. Cancelling clears a dependency edge the
// same way finishing does.
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
  // offers a catalog, but the column stores whatever the client sends and the
  // driver passes it straight to the CLI. This route validates shape only,
  // not content, since provider-native ids and inference-profile ARNs are the
  // driver's business. A control character would reach a spawned process and
  // the transcript, and an unbounded string has no legitimate form, so both
  // are refused. An empty or blank string means "inherit", stored as `null`.
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
  // Provider override (lib/agentEnv.ts): which endpoint and model this
  // task's turns run against, layered over the project's. Accepts an object
  // or JSON text; the store's serialize enforces the allowlist and drops any
  // unlisted key. Refused only when the shape can't be read.
  if ("agent_env" in body) {
    const v = (body as { agent_env?: unknown }).agent_env;
    if (v !== null && typeof v !== "string" && (typeof v !== "object" || Array.isArray(v)))
      return NextResponse.json({ error: "agent_env must be an object, JSON text or null" }, { status: 400 });
    allowed.agent_env = serializeAgentEnv(v);
  }
  // Per-task override of the project's hosted-MCP selection (docs/AGENTS.md,
  // "Hosted MCP servers"). null inherits the project's gateway_mcp; an array
  // or JSON text, including "[]", replaces it outright.
  if ("gateway_mcp" in body) {
    const v = (body as { gateway_mcp?: unknown }).gateway_mcp;
    if (v !== null && !Array.isArray(v) && typeof v !== "string")
      return NextResponse.json({ error: "gateway_mcp must be an array of aliases, JSON text, or null" }, { status: 400 });
    allowed.gateway_mcp = v === null ? null : serializeGatewayMcp(v);
  }
  // Snoozing has two spellings for two different clocks: `snoozed_until` is
  // a deadline the user picked, while `unsnooze` means "back now" and
  // resolves against the server's clock, the one lib/store's NEEDS_YOU
  // predicate compares against. Resolving it server-side avoids leaving a
  // task hidden from the pill if the browser's clock is skewed.
  // The value is validated, not coerced: the column is a ms epoch, and a
  // stray float or NaN would land in SQLite as a value no comparison reads
  // correctly.
  if ("snoozed_until" in body) {
    const v = body.snoozed_until;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
      return NextResponse.json({ error: "snoozed_until must be a non-negative epoch in milliseconds" }, { status: 400 });
    allowed.snoozed_until = v;
  }
  if ((body as { unsnooze?: unknown }).unsnooze === true) allowed.snoozed_until = Date.now();
  // Tag membership is validated here: task_tags is a plain FK pair, so a tag
  // from another project would otherwise be accepted by SQLite and then
  // filter this task out of every view in its own project. `[]` clears every
  // tag. Applied below along with the dependency edges, since both live in a
  // second table rather than a column. (Bulk assignment is a separate route;
  // this is the edit dialog's.)
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
  // Queued start (lib/deferredStart.ts) uses the same shape and validation
  // as the snooze deadline: a ms epoch the user picked (the client reads the
  // usage-window reset off the plan meter), 0 to cancel. A past deadline is
  // accepted, not refused, since it fires on the next sweep: that's what
  // "start once the reset passes" means when the reset already has.
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
  // A manual status change means the user is taking over: clear the "your
  // turn" flag and the ran-clean mark an unattended run left behind. Both
  // answer the same question (does this row still want something from you),
  // and the mark's only way out is a status write, so clearing it alone
  // would drop the task back into the undifferentiated "In progress" pile it
  // was pulled out of (issue #28).
  if ("status" in allowed) {
    allowed.awaiting_input = 0;
    allowed.unread_run_at = 0;
  }
  // Cancelling means "stop working on this": kill any in-flight turn. The
  // runner's finally block settles running=0 and discards the parked queue.
  // The worktree is kept, since cancelling is not deleting, so the diff
  // stays reviewable and the task can be revived by sending another message.
  if (allowed.status === "cancelled") abortTurn(id);
  // Reviving a withdrawn suggestion is centralized here. A withdrawn row is
  // cancelled but still `suggested` (set by the withdraw_suggestion agent
  // tool, so it stays in the tray for the user to bring back), and every way
  // back lands on this route: the tray's Start and Add both patch
  // `suggested: 0` and nothing else, the board's drag sends a status
  // alongside it, the edit dialog re-statuses in place. Both fields must
  // clear together: leaving the reason would strike through a card that's
  // live again, and leaving status at `cancelled` would file the accepted
  // task straight into the Cancelled column.
  const withdrawn = current.status === "cancelled" && current.suggested === 1;
  if (withdrawn && (("status" in allowed && allowed.status !== "cancelled") || ("suggested" in allowed && !allowed.suggested))) {
    allowed.withdrawn_reason = "";
    if (!("status" in allowed)) allowed.status = "not_started";
  }
  // Dependency edges live in their own table, set separately with a cycle guard.
  let depsChanged = false;
  if (Array.isArray((body as { depends_on?: unknown }).depends_on)) {
    const before = getTaskDeps(id);
    try {
      setTaskDeps(id, (body as { depends_on: string[] }).depends_on);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "invalid dependencies" }, { status: 400 });
    }
    // Compared, not assumed: the setter drops unusable refs (cross-project,
    // self, duplicates), so a submitted list is often identical to the
    // stored one. Every edit dialog save submits `depends_on` whether or not
    // the user touched it.
    depsChanged = !sameDepSet(before, getTaskDeps(id));
  }
  // Tags follow the same shape: their own table, compared instead of
  // assumed, since the edit dialog submits the whole list on every save
  // whether or not the user touched it.
  let tagsChanged = false;
  if (nextTagIds) {
    const before = getTaskTagIds(id);
    tagsChanged = before.length !== nextTagIds.length || before.some((t, i) => t !== nextTagIds![i]);
    if (tagsChanged) setTaskTags([id], nextTagIds);
  }
  const task = updateTask(id, allowed);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Announces the write so every other tab refreshes the row instead of
  // rendering a stale one until reload (the tab that made the edit already
  // patched its own state optimistically). Two event types, and the wider
  // one wins when a patch qualifies as both, since `task_edited` triggers a
  // refetch and the listener applies the status/awaiting snapshot either way.
  //   - task_edited: a field the coarse /api/events payload can't carry
  //     changed, such as a rename, reprioritization, or a suggestion
  //     accepted out of the tray. Dependency edges count too, since they
  //     change what the tray draws for neighboring rows and a refetch
  //     redraws them. So do tags, which move the chip bar's counts as well
  //     as this row's badges.
  //   - task_updated: a manual status change settles status and
  //     awaiting_input outside any turn, so no runner publish follows;
  //     without this event every other tab's "needs you" badge keeps
  //     counting this task. Published on any status key, even an unchanged
  //     one, since it also clears awaiting_input, the field the badges
  //     actually read.
  // task_edited compares against the pre-write row, so a no-op save from the
  // edit dialog, which submits every field whether or not it was touched,
  // stays silent instead of forcing every tab to refetch its tray.
  const edited = depsChanged || tagsChanged || EDIT_FIELDS.some((k) => k in allowed && allowed[k] !== current[k]);
  if (edited) publishGlobal(id, { type: "task_edited" });
  else if ("status" in allowed) publishGlobal(id, { type: "task_updated" });
  // A tag write moves the chip bar's derived counts as well as this row,
  // and `task_edited` only says "refetch this task". This is the same event
  // the bulk route and the tag CRUD routes publish, so every surface reading
  // a count refreshes consistently.
  if (tagsChanged) publishGlobal("", { type: "tags_changed", projectId: current.project_id });
  // The sweep that honors a queued start is started by the boot ping;
  // started again here too, so a deadline set on an instance whose ping was
  // lost still fires. Idempotent. Imported dynamically because the module
  // reaches the runner and must not be linked statically from here (see
  // /api/instance/scheduler).
  if (task.start_at > 0) void import("@/lib/deferredStart").then((m) => m.startDeferredStartTicker());
  // Reaching a terminal status may have cleared the last blocker some
  // auto-start dependent was waiting on. done and cancelled both count,
  // since both are what lib/autoStart's blocks() clears; firing only on
  // done would leave a cancelled blocker's dependents unblocked but never
  // launched. Fire-and-forget: the launch runs detached, since worktree
  // creation can take seconds, and must never delay or fail this status
  // change.
  if (isTerminal(task.status) && !isTerminal(prevStatus)) maybeAutoStartDependents(id);
  return NextResponse.json({ ...task, depends_on: getTaskDeps(id) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Uses the same per-task lock the merge/sync/turn-launch paths hold.
  // Those paths re-read the task and then insert rows keyed on it
  // (task_merges, messages), so a delete landing between their re-read and
  // their insert would throw a foreign key error in a route that already
  // validated the row. Locking closes that window; the cascade then removes
  // whatever they committed first.
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
    // Publishes after the hard delete, carrying the project id and its
    // recomputed awaiting count. The row is gone, so /api/events' usual
    // re-read-the-task enrichment would drop the event and freeze the
    // project's badge in every other tab until the next SSE reconnect.
    if (task) publishGlobal(id, { type: "task_deleted", projectId: task.project_id, awaiting_count: countAwaiting(task.project_id) });
  });
  return NextResponse.json({ ok: true });
}
