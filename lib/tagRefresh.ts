// "Refresh tag" — the button on a tag's strip that checks a whole plan against
// the code and fixes what has gone stale.
//
// It is the tag analogue of lib/contextRefresh.ts and copies its shape on
// purpose (detached job, state on the row, polled by GET), but it differs in the
// one way that matters: the context draft produces a DRAFT the user reviews,
// while this one APPLIES its outcome. That is only safe because of where the
// edits land — every task change goes through lib/agentTools.ts and is recorded
// in task_agent_edits, so the user gets the "Changed by agent" chip with a
// per-field before/after and a one-click Revert. Review moved from before the
// write to after it, onto a surface that already existed.
//
// The agent itself writes nothing. It runs read-only (Read/Grep/Glob, no Bash)
// and returns a JSON plan; this module decides what of that plan is allowed to
// happen. Keeping the judgement and the write apart is what makes the audit
// trail real rather than decorative.

import { getProject, getTag, listTasks, setTagRefresh, updateTag, updateTask, recordAgentEdit } from "./store";
import { planTagRefresh, resolveUtilityAgent } from "./agents/oneshots";
import { parseTagPlan, clip, type TagPlan } from "./agents/shared";
import { topoMembers } from "./tagContext";
import { updateTaskForAgent, withdrawSuggestionForAgent, isInertSuggestion, type AgentEditActor } from "./agentTools";
import { publishGlobal } from "./events";
import { recentCommits, isGitRepo } from "./git";
import type { Project, Tag, Task } from "./types";

// Tags whose refresh is genuinely executing in THIS process. Same contract as
// contextRefresh's: the DB row is what a client polls, this is the liveness
// truth that ignores a double-click and spots a row orphaned by a restart.
const inFlight = new Set<string>();

// Longer than the context draft's 10 minutes: that run reads a repo once, this
// one reads it once per member task it has doubts about. A tag with a dozen
// members legitimately takes a while.
const STALE_MS = 20 * 60 * 1000;

export type TagRefreshState = {
  status: Tag["refresh_status"];
  /** The phase label under the bar. "" unless running. */
  stage: string;
  /** What the last finished run changed, in the server's words. */
  summary: string;
  error: string;
  started_at: number;
};

export const STAGE_READING = "Reading the plan";
export const STAGE_APPLYING = "Applying updates";
/** "Checking 7 tasks against the code" — the long phase, so it names the size. */
export const stageChecking = (n: number) => `Checking ${n} task${n === 1 ? "" : "s"} against the code`;

export function isTagRefreshing(tagId: string): boolean {
  return inFlight.has(tagId);
}

function stateOf(t: Tag): TagRefreshState {
  // A "running" row with no live job here, started long enough ago, was
  // orphaned by a restart — report it settled so a polling client unsticks and
  // can retry, rather than watching a bar that will never move again.
  if (t.refresh_status === "running" && !inFlight.has(t.id) && Date.now() - t.refresh_started_at > STALE_MS) {
    return { status: "error", stage: "", summary: "", error: "refresh timed out. Try again", started_at: t.refresh_started_at };
  }
  return {
    status: t.refresh_status,
    stage: t.refresh_stage,
    summary: t.refresh_summary,
    error: t.refresh_error,
    started_at: t.refresh_started_at,
  };
}

/** Current persisted state for a tag (what the strip polls). */
export function getTagRefreshState(tagId: string): TagRefreshState | null {
  const t = getTag(tagId);
  return t ? stateOf(t) : null;
}

/**
 * Acknowledge a finished run: clear the summary/error back to idle so it doesn't
 * resurface every time the chip is lit. No-op while a job is genuinely running.
 * The EDITS are not touched — they live on the tasks, where the agent-edit chip
 * owns their review; this only dismisses the report of them.
 */
export function clearTagRefresh(tagId: string): TagRefreshState | null {
  if (inFlight.has(tagId)) return getTagRefreshState(tagId);
  const t = setTagRefresh(tagId, { refresh_status: "idle", refresh_stage: "", refresh_summary: "", refresh_error: "" });
  if (t) publishGlobal("", { type: "tags_changed", projectId: t.project_id });
  return t ? stateOf(t) : null;
}

/** The tag's members in plan order — the same sequence the strip numbers. */
export function tagMembers(tag: Tag): Task[] {
  return topoMembers(listTasks(tag.project_id).filter((t) => t.tag_ids.includes(tag.id)));
}

/**
 * How a member stands, in the words the plan cares about. The model needs this
 * to judge (c) "already overtaken" honestly — a started task has a checkout and
 * a diff, and saying so is what stops it proposing to retire real work — and
 * this module needs the same distinction to decide what it may retire.
 */
function memberState(t: Task): string {
  if (t.status === "cancelled") return t.withdrawn_reason ? "withdrawn" : "cancelled";
  if (t.status === "done") return "done";
  if (t.running === 1) return "a session is running in it RIGHT NOW";
  if (t.started === 1) return "started — it has a checkout and possibly a diff";
  if (t.suggested === 1) return "an unreviewed suggestion, still in the tray";
  return "accepted, not started";
}

/**
 * The digest handed to the agent: the tag, its saved description, every member's
 * brief, and recent git activity. Descriptions ARE included, unlike list_tags's
 * deliberately shallow view — judging whether a brief has gone stale is exactly
 * the job, and it cannot be done from a title.
 */
export async function buildTagDigest(project: Project, tag: Tag, members: Task[]): Promise<string> {
  const lines: string[] = [];
  lines.push(`Tag: ${tag.name}`);
  lines.push(`Saved description (may be stale): ${tag.description || "(none — write one)"}`);
  if (tag.base_branch) lines.push(`Plan base branch: ${tag.base_branch}`);
  lines.push("");
  lines.push(`Members, in plan order (${members.length}):`);
  members.forEach((m, i) => {
    lines.push("");
    lines.push(`--- step ${i + 1} of ${members.length} ---`);
    lines.push(`id: ${m.id}`);
    lines.push(`title: ${m.title}`);
    lines.push(`status: ${m.status} (${memberState(m)})`);
    lines.push(`description:`);
    lines.push(clip(m.description || "(none)", 3000));
  });
  if (!members.length) lines.push("(none — nothing carries this tag)");

  const repo = project.repo_path;
  if (repo && (await isGitRepo(repo).catch(() => false))) {
    const commits = await recentCommits(repo, 20).catch(() => "");
    if (commits) {
      lines.push("");
      lines.push("=== RECENT COMMITS ===");
      lines.push(commits);
    }
  }
  return lines.join("\n");
}

/** What one run actually did, for the line under the bar. */
export interface TagRefreshOutcome {
  descriptionRewritten: boolean;
  reworded: number;
  retired: number;
  /** Members the plan wanted to retire that this module refused to. */
  flagged: string[];
  /** Ids in the plan that aren't members of this tag — the model made them up. */
  ignored: number;
  summary: string;
}

/**
 * Apply a parsed plan. Exported for the tests, which is also the reason it takes
 * everything it needs rather than re-reading: the policy below is the whole
 * feature, and it has to be assertable without an agent in the loop.
 *
 * Three things it will do, and one it won't:
 *   - rewrite the tag's description;
 *   - reword a member's title/description, through updateTaskForAgent, so it
 *     lands as a revertable agent edit;
 *   - retire a member that has NO WORK IN IT — an unreviewed suggestion (via the
 *     ordinary withdraw path, which leaves it struck through in the tray) or a
 *     task the user accepted but never started. Cancelling either destroys
 *     nothing and Revert puts it back exactly.
 *   - it will NOT retire a STARTED task. That task has a checkout and probably a
 *     diff, and no amount of reading the main branch tells you what is in it.
 *     Those are named in the summary for the user to judge, which is the same
 *     answer withdraw_suggestion's own refusal gives.
 */
export function applyTagPlan(tag: Tag, members: Task[], plan: TagPlan, actor: AgentEditActor): TagRefreshOutcome {
  const byId = new Map(members.map((m) => [m.id, m]));
  const out: TagRefreshOutcome = {
    descriptionRewritten: false, reworded: 0, retired: 0, flagged: [], ignored: 0, summary: "",
  };
  const cleared: string[] = [];

  for (const entry of plan.tasks) {
    const member = byId.get(entry.id);
    // An id that isn't in this tag is either a hallucination or another plan's
    // task. Either way it isn't what the user pressed the button about.
    if (!member) {
      out.ignored++;
      continue;
    }
    if (entry.retire) {
      // The prompt requires a reason and the parser drops empty ones; without
      // one there is nothing to show the user, so nothing happens.
      const reason = entry.reason ?? "";
      if (!reason) {
        out.ignored++;
        continue;
      }
      if (member.running === 1 || member.started === 1 || member.status === "done" || member.status === "cancelled") {
        // Started (or already settled) — report, don't touch.
        if (member.status !== "done" && member.status !== "cancelled") out.flagged.push(`${member.title} — ${reason}`);
        continue;
      }
      if (isInertSuggestion(member)) {
        const r = withdrawSuggestionForAgent(actor, member.id, reason);
        if (r.task) {
          out.retired++;
          if (r.autoStartDependents) cleared.push(member.id);
        } else out.flagged.push(`${member.title} — ${reason}`);
        continue;
      }
      // Accepted but never started: no checkout, no diff, nothing to lose. The
      // withdraw tool won't touch it (its gate protects work an agent shouldn't
      // retract unasked, and this is the user's own button), so cancel it here
      // and record the status move as an agent edit — that is what makes it
      // revertable, and a cancel nobody can undo is not something to do on the
      // strength of a model's reading.
      const before = member.status;
      const updated = updateTask(member.id, { status: "cancelled", withdrawn_reason: reason, awaiting_input: 0 });
      if (!updated) continue;
      recordAgentEdit({
        task_id: member.id,
        project_id: member.project_id,
        actor_task_id: actor.id,
        actor_title: actor.title,
        actor_agent: actor.agent,
        changes: [{ field: "status", before, after: "cancelled", before_value: before, after_value: "cancelled" }],
      });
      publishGlobal(member.id, { type: "task_edited" });
      out.retired++;
      cleared.push(member.id);
      continue;
    }

    const patch: { title?: string; description?: string } = {};
    if (entry.title && entry.title !== member.title) patch.title = entry.title;
    if (entry.description && entry.description !== member.description) patch.description = entry.description;
    if (!patch.title && !patch.description) continue;
    const r = updateTaskForAgent(actor, member.id, patch);
    if (r.task) out.reworded++;
  }

  if (plan.description && plan.description !== tag.description) {
    if (updateTag(tag.id, { description: plan.description })) out.descriptionRewritten = true;
  }

  // A retirement is a non-terminal → terminal transition, so a dependent parked
  // on "start when unblocked" may now be free. Same sweep the tool paths run.
  if (cleared.length) {
    void import("./autoStart")
      .then(({ maybeAutoStartDependents }) => {
        for (const id of cleared) maybeAutoStartDependents(id);
      })
      .catch(() => {});
  }

  out.summary = summarize(out);
  return out;
}

// The one line under the bar. It says what happened, including "nothing" —
// a refresh that found a healthy plan has done its job and must not read like a
// failure, or the button stops being worth pressing on a plan you believe in.
function summarize(o: TagRefreshOutcome): string {
  const parts: string[] = [];
  if (o.descriptionRewritten) parts.push("description rewritten");
  if (o.reworded) parts.push(`${o.reworded} task${o.reworded === 1 ? "" : "s"} reworded`);
  if (o.retired) parts.push(`${o.retired} retired`);
  const head = parts.length ? `${parts.join(" · ")}. Every task change is revertable from its "Changed by agent" chip.` : "Nothing needed changing — the plan still matches the code.";
  if (!o.flagged.length) return head;
  const which = o.flagged.map((f) => `· ${f}`).join("\n");
  return `${head}\nLooks already handled, but has work in it — left alone for you to judge:\n${which}`;
}

// The run itself, detached. Persists whatever it reaches, so a client that
// reconnects minutes later still gets the report.
async function runRefresh(project: Project, tag: Tag): Promise<void> {
  try {
    const members = tagMembers(tag);
    const digest = await buildTagDigest(project, tag, members);

    setTagRefresh(tag.id, { refresh_stage: stageChecking(members.length) });
    const raw = await planTagRefresh(project, digest);

    setTagRefresh(tag.id, { refresh_stage: STAGE_APPLYING });
    // Re-read the members: the exploration takes minutes, and a sibling session
    // can start, finish or cancel one of them while it runs. The plan is a
    // judgement about ids, not about the rows the job opened with.
    const fresh = getTag(tag.id);
    if (!fresh) return; // deleted mid-run; nothing to write back to
    const actor: AgentEditActor = {
      id: `tag:${tag.id}`,
      title: `Refresh of tag "${fresh.name}"`,
      agent: resolveUtilityAgent().id ?? resolveUtilityAgent().configured,
    };
    const outcome = applyTagPlan(fresh, tagMembers(fresh), parseTagPlan(raw), actor);

    setTagRefresh(tag.id, { refresh_status: "done", refresh_stage: "", refresh_summary: outcome.summary, refresh_error: "" });
  } catch (e) {
    setTagRefresh(tag.id, {
      refresh_status: "error",
      refresh_stage: "",
      refresh_error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    inFlight.delete(tag.id);
    // Every tab refetches, so a strip that was never the one polling still
    // stops showing a bar.
    publishGlobal("", { type: "tags_changed", projectId: tag.project_id });
  }
}

/**
 * Start a refresh in the BACKGROUND and return its state immediately. The
 * exploration takes minutes and must survive lighting a different chip,
 * switching project, closing the strip or reloading the tab — so nothing about
 * it lives in the request or in the component. Idempotent on a double-click: a
 * live job is left alone and its state handed back.
 */
export function startTagRefreshJob(tagId: string): TagRefreshState {
  const tag = getTag(tagId);
  if (!tag) throw new Error("tag not found");
  const project = getProject(tag.project_id);
  if (!project) throw new Error("project not found");

  const liveOrFresh =
    inFlight.has(tagId) || (tag.refresh_status === "running" && Date.now() - tag.refresh_started_at < STALE_MS);
  if (liveOrFresh) return stateOf(tag);

  if (!project.repo_path) {
    const t = setTagRefresh(tagId, {
      refresh_status: "error",
      refresh_stage: "",
      refresh_error: "set a working directory on the project before refreshing a tag",
    });
    return stateOf(t ?? tag);
  }

  inFlight.add(tagId);
  const t = setTagRefresh(tagId, {
    refresh_status: "running",
    refresh_stage: STAGE_READING,
    refresh_summary: "",
    refresh_error: "",
    refresh_started_at: Date.now(),
  });
  publishGlobal("", { type: "tags_changed", projectId: tag.project_id });
  void runRefresh(project, t ?? tag);
  return stateOf(t ?? tag);
}
