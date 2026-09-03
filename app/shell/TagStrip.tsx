"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { isAwaiting, isWithdrawn } from "./format";
import { StatusDot } from "./shared";
import { TAG_COLORS, type TagRow, type TaskRow } from "./types";
import { tagTint } from "./TagChips";

// The tag strip: what a lit chip expands into. There is no tag route and no tag
// page — a tag's whole detail view is this band under the chip bar (design:
// docs/superpowers/specs/2026-08-27-tags-design.md). It shows the description,
// the progress, where the plan came from, the tasks in the order they have to
// happen, and the two verbs a tag has (Edit, Delete). Everything else about a
// tag IS its tasks.
//
// Shown only when exactly ONE chip is lit. Two lit chips are a filter over two
// plans, and stacking two strips (or picking one of them to expand) would put a
// band of prose about one feature above a list showing both. The chip bar is
// the multi-tag surface; this is the single-tag one.

/**
 * The members in dependency order — a topological sort over `depends_on`
 * restricted to the group, with ties broken by `position`, the project's
 * filing sequence.
 *
 * Filing order, deliberately, and NOT the order the caller passed: the tray
 * sorts by recency, and a plan's steps must not renumber themselves every time
 * one of them runs. `position` is the one total order both sides can agree on
 * (`created_at` collides — a planning turn files its whole batch inside one
 * millisecond), and lib/tagContext.ts sorts by exactly the same thing, so
 * "step 3 of 7" in a session's context and "3" on the user's screen keep
 * naming the same task.
 *
 * Edges to tasks WITHOUT this tag are ignored rather than treated as
 * blockers: tags and dependencies are orthogonal (a member may legitimately
 * wait on something in another feature), and ordering this list by them would
 * make "step 3 of 7" depend on tasks the list doesn't show.
 */
export function topoMembers(members: TaskRow[]): TaskRow[] {
  members = [...members].sort((a, b) => a.position - b.position);
  const ids = new Set(members.map((m) => m.id));
  const deps = new Map(members.map((m) => [m.id, (m.depends_on ?? []).filter((d) => ids.has(d))]));
  const placed = new Set<string>();
  const out: TaskRow[] = [];
  while (out.length < members.length) {
    const ready = members.find((m) => !placed.has(m.id) && deps.get(m.id)!.every((d) => placed.has(d)));
    // setTaskDeps refuses cycles, so `ready` is only ever empty if the graph
    // arrived broken — take the next unplaced member rather than spinning.
    const pick = ready ?? members.find((m) => !placed.has(m.id))!;
    placed.add(pick.id);
    out.push(pick);
  }
  return out;
}

/**
 * "5 done · 2 withdrawn". Terminal members are counted the way `blocks()`
 * counts them, so a tag on seven tasks with two withdrawn suggestions really is
 * finished at five — but the withdrawals are named beside the fraction rather
 * than folded into it, or `5/5` on a seven-row list reads as a lie. Withdrawn
 * and plainly cancelled are told apart here (the strip has the rows; the
 * tag's derived counts only know `cancelled`).
 */
export function memberProgress(members: TaskRow[]): { done: number; of: number; pct: number; parts: string[] } {
  const done = members.filter((m) => m.status === "done").length;
  const withdrawn = members.filter((m) => isWithdrawn(m)).length;
  const cancelled = members.filter((m) => m.status === "cancelled").length - withdrawn;
  const of = members.length - withdrawn - cancelled;
  const parts = [`${done} done`];
  if (withdrawn) parts.push(`${withdrawn} withdrawn`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  return { done, of, pct: of > 0 ? (done / of) * 100 : 0, parts };
}

/**
 * What setting this tag's base branch would actually do — the line under the
 * field, computed against the members on screen.
 *
 * This exists because `base_branch` is the one tag field whose blast radius
 * isn't obvious from the form, and the count is the whole reason editing it is
 * safe: inheritance stops at the worktree cut, so a member that has already been
 * cut keeps the branch its work is built on no matter what is typed here.
 *
 * It also has to name the OTHER-TAG case. A task carries as many tags as it has
 * reasons to, and the base comes from the first one (in tag order) that sets a
 * branch — so a member of this tag can perfectly well take its base from a
 * different tag. Resolving that silently would make a branch appear from a tag
 * the user wasn't looking at; saying which tag won is the price of resolving it
 * instead of refusing it (lib/baseBranch.ts).
 *
 * `base` is the PENDING value in the form, not the saved one, so the line moves
 * as the field is typed into.
 */
export function baseConsequence(args: {
  tag: TagRow;
  base: string;
  members: TaskRow[];
  /** Every tag in the project — a member's base may come from any of them. */
  allTags: TagRow[];
  projectBranch: string;
}): string[] {
  const { tag, members, allTags, projectBranch } = args;
  const base = args.base.trim();
  const byId = new Map(allTags.map((t) => [t.id, t]));
  // This tag's base as the form currently has it; every other tag's as stored.
  const baseOf = (id: string) => (id === tag.id ? base : byId.get(id)?.base_branch ?? "");

  const pinned = new Map<string, number>(); // already has a base of its own → branch → count
  const overridden = new Map<string, number>(); // another tag wins → that tag's name → count
  let inherits = 0;
  for (const m of members) {
    if (m.base_branch) {
      if (m.base_branch !== base) pinned.set(m.base_branch, (pinned.get(m.base_branch) ?? 0) + 1);
      continue;
    }
    const winner = (m.tag_ids ?? []).find((id) => baseOf(id));
    if (!winner) continue; // nothing sets a base — it follows the project either way
    if (winner === tag.id) inherits++;
    else {
      const name = byId.get(winner)?.name ?? "another tag";
      overridden.set(name, (overridden.get(name) ?? 0) + 1);
    }
  }

  const n = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
  const lines: string[] = [];
  lines.push(
    base
      ? `New tasks tagged this branch from ${base}.` +
        (inherits ? ` So do ${n(inherits, "task", "tasks")} already tagged but not yet cut.` : "")
      : `Tasks tagged this follow the project's default (${projectBranch || "unset"}).`
  );
  // "Already based on", not "already cut from": a base is usually pinned by the
  // worktree cut, but an explicit retarget can pin one before a task ever runs.
  if (pinned.size) {
    const where = [...pinned.entries()].map(([b, c]) => `${b} (${c})`).join(", ");
    const total = [...pinned.values()].reduce((a, b) => a + b, 0);
    lines.push(`${n(total, "task", "tasks")} already based on ${pinned.size === 1 ? [...pinned.keys()][0] : where} keep${total === 1 ? "s" : ""} it.`);
  }
  if (overridden.size) {
    const who = [...overridden.entries()].map(([name, c]) => `${name}${overridden.size > 1 ? ` (${c})` : ""}`).join(", ");
    const total = [...overridden.values()].reduce((a, b) => a + b, 0);
    lines.push(`${n(total, "task takes", "tasks take")} the base from an earlier tag instead: ${who}.`);
  }
  return lines;
}

/** What `GET /api/tags/[id]/sync` answers with — `lib/git.ts`'s BranchDrift, plus
 *  the two shapes that need no git at all. */
export interface TagDriftInfo {
  inherited?: boolean; // the tag has no base of its own
  sameAsProject?: boolean; // its base IS the project default
  projectBranch?: string;
  branch?: string;
  against?: string;
  exists?: boolean;
  againstExists?: boolean;
  behind?: number;
  ahead?: number;
  diverged?: boolean;
  unknown?: boolean;
}

/**
 * The one line a drift reading is worth, and whether Sync or Create is on
 * offer — split out from the component because it is the whole judgement and
 * the rest is plumbing.
 *
 * `null` means say nothing: a tag that follows the project default, or names it
 * explicitly, has no second branch to fall behind. "Up to date" IS said, though,
 * because the absence of a warning is not the same as having been told, and this
 * band is where someone comes to check.
 *
 * Being ahead is not reported. An integration branch is ahead of main by
 * definition — that's what it's for — and counting it beside the number that
 * matters would bury it.
 */
export function driftLine(d: TagDriftInfo): { text: string; tone: "ok" | "warn" | "bad"; syncable: boolean; creatable?: boolean } | null {
  if (d.inherited || d.sameAsProject) return null;
  const branch = d.branch || "this tag's base branch";
  const against = d.against || d.projectBranch || "the project default";
  // Git can't tell a deleted branch from one nobody has created yet, and the
  // usual case is the latter: a base typed into the editor before any plan cut
  // it. Said as "yet", with Create on offer, rather than mourning a branch that
  // never was.
  if (d.exists === false)
    return {
      text: `${branch} doesn't exist here yet — new tasks are cut from HEAD until it does`,
      tone: "bad",
      syncable: false,
      creatable: d.againstExists !== false,
    };
  if (d.againstExists === false) return { text: `${against} doesn't exist here`, tone: "bad", syncable: false };
  if (d.unknown) return { text: `can't compare with ${against}`, tone: "warn", syncable: false };
  const behind = d.behind ?? 0;
  if (behind === 0) return { text: `up to date with ${against}`, tone: "ok", syncable: false };
  return { text: `${behind} behind ${against}`, tone: "warn", syncable: true };
}

/**
 * Drift of the tag's base branch from the project default, and the Sync that
 * closes it. Sits above the strip's two modes so the editor — where the base
 * branch is typed — shows it as well as the read view where the badge is.
 *
 * Fetched per tag on open rather than served with the tag list: see the route.
 * The saved `tag.base_branch` is the key, so typing in the editor doesn't refetch
 * on every keystroke, and saving a new branch does.
 */
function TagDriftRow({ tag }: { tag: TagRow }) {
  const [drift, setDrift] = useState<TagDriftInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tag.base_branch) return setDrift(null);
    try {
      setDrift(await jget<TagDriftInfo>(`/api/tags/${tag.id}/sync`));
    } catch {
      setDrift(null); // a drift reading nobody can take is not worth an error band
    }
  }, [tag.id, tag.base_branch]);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const r = await jsend<{ behind?: number }>(`/api/tags/${tag.id}/sync`, "POST");
      setNote(`Merged ${r.behind ?? 0} commit(s) in.`);
    } catch (e) {
      // Every refusal — a dirty worktree holding the branch, a conflict, a
      // missing ref — arrives as the route's 409 and `jsend` unwraps its
      // `error` verbatim, which is the whole point of phrasing them for a
      // reader in lib/git.ts.
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void load();
    }
  };

  // The branch that exists nowhere: cut it at the project default's tip, the
  // commit the tag's first task would otherwise have been cut from.
  const create = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const r = await jsend<{ branch: string; from: string }>(`/api/tags/${tag.id}/sync`, "POST", { action: "create" });
      setNote(`Created ${r.branch} at ${r.from}'s tip.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void load();
    }
  };

  const line = drift && driftLine(drift);
  if (!line) return null;
  return (
    <div className={`gs-drift ${line.tone}`}>
      <span className="gs-drift-msg mono">{line.text}</span>
      {line.syncable && (
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void sync()}
          title={`Merge ${drift?.against ?? "the project default"} into ${drift?.branch ?? "this branch"}, so tasks tagged this stop being cut stale`}>
          {busy ? "Syncing…" : "Sync"}
        </button>
      )}
      {line.creatable && (
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void create()}
          title={`Create ${drift?.branch ?? "this branch"} at ${drift?.against ?? "the project default"}'s current tip, so tasks tagged this are cut from it`}>
          {busy ? "Creating…" : `Create from ${drift?.against ?? "default"}`}
        </button>
      )}
      {note && <span className="gs-drift-note">{note}</span>}
      {err && <span className="gs-drift-err">{err}</span>}
    </div>
  );
}

/** Mirrors TagRefreshState in lib/tagRefresh.ts — what GET/POST/DELETE .../refresh return. */
type JobState = {
  status: TagRow["refresh_status"];
  stage: string;
  summary: string;
  error: string;
  started_at: number;
};

/** The job as the tag row last recorded it — the reconnect seed. */
const jobOf = (t: TagRow): JobState => ({
  status: t.refresh_status,
  stage: t.refresh_stage,
  summary: t.refresh_summary,
  error: t.refresh_error,
  started_at: t.refresh_started_at,
});

export function TagStrip({ tag, members, allTags, projectBranch, originTask, onSelectTask, onDeleted }: {
  tag: TagRow;
  /** Every task carrying the tag, in tray order — the strip sorts them itself. */
  members: TaskRow[];
  /** Every tag in the project, so the base-branch line can name the tag that wins. */
  allTags: TagRow[];
  /** The project's default base, what an unset tag base falls back to. */
  projectBranch: string;
  /** The planning session that filed this tag, when it's still in this project. */
  originTask?: TaskRow;
  onSelectTask: (id: string) => void;
  /** Called after the tag row is gone, so the chip bar can fall back to All. */
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(tag.name);
  const [desc, setDesc] = useState(tag.description);
  const [color, setColor] = useState<string | null>(tag.color);
  const [base, setBase] = useState(tag.base_branch);
  const [job, setJob] = useState<JobState>(() => jobOf(tag));

  // The job outlives this component. Its state is on the tag ROW, which arrives
  // with every tags_changed refetch (TagRow IS Tag), so a strip mounting fresh —
  // after lighting another chip, switching project, or a reload — already knows
  // a run is in flight and picks the bar back up without asking.
  useEffect(() => {
    setJob(jobOf(tag));
  }, [tag.id, tag.refresh_status, tag.refresh_stage, tag.refresh_summary, tag.refresh_error, tag.refresh_started_at]);

  // The row only moves on tags_changed, which the job publishes at its two ENDS.
  // Polling is what makes the stage label advance in between, and what settles a
  // run promptly rather than on the next global event.
  useEffect(() => {
    if (job.status !== "running") return;
    let live = true;
    const t = setInterval(() => {
      void jget<JobState>(`/api/tags/${tag.id}/refresh`)
        .then((s) => { if (live) setJob(s); })
        .catch(() => {});
    }, 2500);
    return () => { live = false; clearInterval(t); };
  }, [job.status, tag.id]);

  const refresh = async () => {
    setErr(null);
    // Optimistic: the POST returns the running state, but the click should light
    // the bar immediately rather than a request round-trip later.
    setJob({ status: "running", stage: "Reading the plan", summary: "", error: "", started_at: Date.now() });
    try {
      setJob(await jsend<JobState>(`/api/tags/${tag.id}/refresh`, "POST"));
    } catch (e) {
      setJob({ status: "error", stage: "", summary: "", error: e instanceof Error ? e.message : String(e), started_at: 0 });
    }
  };

  const dismissJob = async () => {
    setJob({ status: "idle", stage: "", summary: "", error: "", started_at: 0 });
    await jsend<JobState>(`/api/tags/${tag.id}/refresh`, "DELETE").catch(() => {});
  };

  // Another tab (or the delete below) can change the tag under the form.
  // Re-seed the fields whenever the row we're editing actually changes.
  useEffect(() => {
    setName(tag.name);
    setDesc(tag.description);
    setColor(tag.color);
    setBase(tag.base_branch);
  }, [tag.id, tag.name, tag.description, tag.color, tag.base_branch]);

  const ordered = topoMembers(members);
  const p = memberProgress(members);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // The tags_changed echo refetches the project, so nothing is
      // written into local state here — the chip bar and this strip re-render
      // from the same read.
      await jsend(`/api/tags/${tag.id}`, "PATCH", {
        name: name.trim(), description: desc, color: color ?? "", base_branch: base.trim(),
      });
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    // Two-step, like every other hard delete here: the first click arms it and
    // says how many tasks it touches, so the count is on screen before the
    // tag is gone.
    if (!confirmDel) return setConfirmDel(true);
    setBusy(true);
    setErr(null);
    try {
      await jsend(`/api/tags/${tag.id}`, "DELETE");
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setConfirmDel(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gstrip" style={tagTint(tag.color)}>
      <TagDriftRow tag={tag} />
      {editing ? (
        <div className="gs-edit">
          <input className="gs-name-in" value={name} aria-label="Tag name" autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }} />
          <textarea className="gs-desc-in" value={desc} rows={2} aria-label="Tag description"
            placeholder="What this tag means: shown here and given to every session carrying it."
            onChange={(e) => setDesc(e.target.value)} />
          {/* The plan's base branch, set once here instead of on every task.
              It is a DEFAULT: inheritance stops at the worktree cut, so the
              line below says how many members are already past that point and
              which of them take their base from a different tag. */}
          <label className="gs-base">
            <span className="gs-base-lbl">Base branch</span>
            <input className="gs-base-in mono" value={base} aria-label="Tag base branch"
              placeholder={`${projectBranch || "the project's default"} (inherited)`}
              onChange={(e) => setBase(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }} />
          </label>
          <div className="gs-base-note">
            {baseConsequence({ tag, base, members, allTags, projectBranch }).map((l, i) => <div key={i}>{l}</div>)}
          </div>
          <div className="gs-colors" role="group" aria-label="Tag color">
            <button type="button" className={`gs-sw none ${color === null ? "on" : ""}`} title="No tint"
              aria-pressed={color === null} onClick={() => setColor(null)} />
            {TAG_COLORS.map((c) => (
              <button key={c} type="button" className={`gs-sw ${color === c ? "on" : ""}`} style={{ background: c }}
                title={c} aria-label={`Color ${c}`} aria-pressed={color === c} onClick={() => setColor(c)} />
            ))}
            <span className="spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(false); setErr(null); }}>Cancel</button>
            <button className="btn btn-accent btn-sm" disabled={!name.trim() || busy} onClick={() => void save()}>Save</button>
          </div>
        </div>
      ) : (
        <>
          <div className="gs-head">
            <span className="gs-name">{tag.name}</span>
            <span className="gs-frac mono">{p.parts.join(" · ")}</span>
            <span className="spacer" />
            {/* Shown only when the tag sets one: every tag reading "main" would
                be noise, the one reading "feature/auth" is the whole point. */}
            {tag.base_branch && (
              <span className="gs-base-badge mono" title={`Tasks tagged this are cut from ${tag.base_branch} instead of ${projectBranch}`}>
                {tag.base_branch}
              </span>
            )}
            {/* The plan's own maintenance verb. It reads the tasks against the
                code and fixes what drifted — so it sits with Edit rather than
                inside it: editing is what the user writes, this is what the
                repo says. Disabled while running, because the job is keyed by
                tag and a second click would only return the first one's state. */}
            <button className="btn btn-ghost btn-sm" disabled={job.status === "running" || !ordered.length}
              onClick={() => void refresh()}
              title={ordered.length
                ? "Read this plan's tasks against the code, reword what's gone stale and rewrite the description"
                : "Nothing carries this tag yet"}>
              {Icon.spark()} {job.status === "running" ? "Refreshing…" : "Refresh tag"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)} title="Rename, describe, recolor or re-base this tag">
              {Icon.edit()} Edit
            </button>
            <button className={`btn btn-sm ${confirmDel ? "btn-danger" : "btn-ghost"}`} disabled={busy} onClick={() => void del()}
              title="Delete the tag. Its tasks are kept, and keep their other tags">
              {confirmDel
                ? `Delete: ${members.length} task${members.length === 1 ? "" : "s"} stay${members.length === 1 ? "s" : ""}`
                : "Delete tag"}
            </button>
            {confirmDel && <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(false)}>Cancel</button>}
          </div>
          {/* The bar measures work still counted: withdrawn and cancelled
              tasks are out of the denominator, named in the fraction above. */}
          <div className="gs-bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.of} aria-valuenow={p.done}
            aria-label={`${tag.name} progress`}>
            <span style={{ width: `${p.pct}%` }} />
          </div>
          {/* The job's own band, directly under the progress bar and above the
              description it is about to rewrite. Indeterminate on purpose: the
              long phase is an agent reading a repo, and a bar that claimed a
              percentage would be inventing one. The stage says what it's doing
              and the note says the part people actually worry about — that
              navigating away doesn't cancel it. */}
          {job.status === "running" && (
            <div className="gs-job" role="status" aria-live="polite">
              <div className="gs-job-bar" aria-hidden="true"><span /></div>
              <div className="gs-job-stage">{job.stage || "Working"}… you can leave this tag — it keeps running.</div>
            </div>
          )}
          {job.status === "done" && job.summary && (
            <div className="gs-job">
              <div className="gs-job-sum">{job.summary}</div>
              <button className="btn btn-ghost btn-sm" onClick={() => void dismissJob()}>Dismiss</button>
            </div>
          )}
          {job.status === "error" && job.error && (
            <div className="gs-job err">
              <div className="gs-job-sum">Refresh failed: {job.error}</div>
              <button className="btn btn-ghost btn-sm" onClick={() => void refresh()}>Retry</button>
              <button className="btn btn-ghost btn-sm" onClick={() => void dismissJob()}>Dismiss</button>
            </div>
          )}
          {tag.description && <div className="gs-desc">{tag.description}</div>}
          {originTask && (
            <button className="gs-origin" onClick={() => onSelectTask(originTask.id)}
              title="The session that planned this tag. Its transcript is the brief">
              {Icon.spark()} Planned in <em>{originTask.title}</em>
            </button>
          )}
          <ol className="gs-members">
            {ordered.map((t, i) => (
              <li key={t.id}>
                <button className={`gs-member ${isWithdrawn(t) ? "gone" : ""}`} onClick={() => onSelectTask(t.id)}>
                  <span className="gs-step mono">{i + 1}</span>
                  <StatusDot status={t.status} running={t.running === 1} awaiting={isAwaiting(t)} />
                  <span className="gs-mtitle">{t.title}</span>
                  {t.suggested === 1 && !isWithdrawn(t) && <span className="gs-tag">suggested</span>}
                  {isWithdrawn(t) && <span className="gs-tag">withdrawn</span>}
                </button>
              </li>
            ))}
            {ordered.length === 0 && <li className="gs-none">No tasks yet. Nothing carries this tag.</li>}
          </ol>
        </>
      )}
      {err && <div className="gs-err">{err}</div>}
    </div>
  );
}
