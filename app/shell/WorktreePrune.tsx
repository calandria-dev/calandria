"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { LoadNote, ErrNote } from "./shared";
import { fmtBytes } from "./format";

interface Candidate {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  branch: string;
  mergedAt: number;
  cleanupAt: number;
  status: string;
  sizeBytes: number;
  running: boolean;
  unsafe: boolean; // dirty or ahead — removing it would lose work
  unsafeReason: string | null;
  canDiscard: boolean; // Done tasks may be explicitly destroyed even when unsafe
}
interface PruneList {
  candidates: Candidate[];
  totalBytes: number;
}
interface PruneResult {
  pruned: string[];
  discarded: string[];
  skipped: { taskId: string; reason: string }[];
  reclaimedBytes: number;
}

const DAY = 86_400_000;
const daysAgo = (at: number) => Math.floor((Date.now() - at) / DAY);
const cleanupLabel = (c: Candidate) => {
  const d = daysAgo(c.cleanupAt);
  const action = c.mergedAt ? "merged" : "done";
  if (d <= 0) return `${action} today`;
  return `${action} ${d} day${d === 1 ? "" : "s"} ago`;
};

// Settings cleanup for merged worktrees and worktrees belonging to Done tasks.
// Safe cleanup retains branches by default. Unmerged work in a Done task can be
// explicitly discarded, which permanently deletes its edits and task branch.
export function WorktreePrune() {
  const [list, setList] = useState<PruneList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minDays, setMinDays] = useState(0);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PruneResult | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    setResult(null);
    setConfirming(false);
    jget<PruneList>("/api/maintenance/worktrees")
      .then((d) => {
        setList(d);
        // Drop any now-stale selections (pruned elsewhere, or filtered out).
        setSelected((prev) => new Set(d.candidates.filter((c) => prev.has(c.taskId)).map((c) => c.taskId)));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Candidates old enough to show, based on merge time or the time marked Done.
  const shown = useMemo(
    () => (list?.candidates ?? []).filter((c) => daysAgo(c.cleanupAt) >= minDays),
    [list, minDays]
  );
  const selectable = useMemo(() => shown.filter((c) => !c.running && (!c.unsafe || c.canDiscard)), [shown]);
  const selectedList = useMemo(() => shown.filter((c) => selected.has(c.taskId)), [shown, selected]);
  const destructiveList = useMemo(() => selectedList.filter((c) => c.unsafe), [selectedList]);
  const selectedBytes = selectedList.reduce((s, c) => s + c.sizeBytes, 0);
  const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.taskId));

  const toggle = (taskId: string) => {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };
  const toggleAll = () => {
    setConfirming(false);
    setSelected(allSelected ? new Set() : new Set(selectable.map((c) => c.taskId)));
  };

  async function prune() {
    if (selectedList.length === 0) return;
    if (!confirming) { setConfirming(true); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await jsend<PruneResult>("/api/maintenance/worktrees", "POST", {
        taskIds: selectedList.map((c) => c.taskId),
        deleteBranch,
        discardChanges: destructiveList.length > 0,
      });
      setResult(res);
      setSelected(new Set());
      setConfirming(false);
      // Reload the candidate list without wiping the just-shown result banner.
      const fresh = await jget<PruneList>("/api/maintenance/worktrees");
      setList(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="field">
        <div className="lab">{Icon.archive()} Reclaim task worktrees</div>
        <div className="hlp" style={{ marginTop: 0, marginBottom: 12 }}>
          Every task runs in its own git worktree. Remove worktrees for merged or Done tasks to reclaim their disk.
          Safe cleanup <strong>keeps the branch</strong> by default, so reopening recreates the worktree with its commits.
          A Done task with unmerged work can also be discarded, but its edits and branch are permanently deleted.
        </div>

        {error && <ErrNote style={{ marginBottom: 10 }} onRetry={refresh}>{error}</ErrNote>}
        {result && (
          <div className="hlp" style={{ marginBottom: 10 }}>
            {Icon.check()} Removed {result.pruned.length} worktree{result.pruned.length === 1 ? "" : "s"}, reclaimed{" "}
            <strong>{fmtBytes(result.reclaimedBytes)}</strong>
            {result.discarded.length > 0 && ` · permanently discarded work from ${result.discarded.length}`}
            {result.skipped.length > 0 && ` · skipped ${result.skipped.length} (${result.skipped.map((s) => s.reason).join(", ")})`}
          </div>
        )}

        {list == null && !error ? (
          <LoadNote style={{ padding: 0 }}>Scanning worktrees…</LoadNote>
        ) : list == null ? null : list.candidates.length === 0 ? (
          <div className="hlp" style={{ marginTop: 0 }}>No merged or Done task worktrees to remove — nothing to reclaim. 🎉</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
              <label className="hlp" style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                Finished more than
                <input
                  type="number" min={0} value={minDays}
                  onChange={(e) => setMinDays(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                  style={{ width: 64 }}
                />
                days ago
              </label>
              <span className="spacer" style={{ flex: 1 }} />
              <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={busy}>{Icon.restore()} Rescan</button>
            </div>

            <div style={{ border: "1px solid var(--line, #2a2a2a)", borderRadius: 8, overflow: "hidden" }}>
              <label className="prune-row" style={rowStyle(true)}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={selectable.length === 0} />
                <span style={{ flex: 1, fontWeight: 600 }}>
                  {shown.length} worktree{shown.length === 1 ? "" : "s"}
                  {minDays > 0 && list.candidates.length !== shown.length ? ` (of ${list.candidates.length})` : ""}
                </span>
                <span className="hlp" style={{ margin: 0 }}>{fmtBytes(shown.reduce((s, c) => s + c.sizeBytes, 0))} total</span>
              </label>
              {shown.map((c) => (
                <label key={c.taskId} className="prune-row" style={rowStyle(false)} title={c.unsafe ? c.unsafeReason ?? undefined : c.branch}>
                  <input
                    type="checkbox"
                    checked={selected.has(c.taskId)}
                    onChange={() => toggle(c.taskId)}
                    disabled={c.running || (c.unsafe && !c.canDiscard)}
                  />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <span style={{ opacity: 0.6 }}>{c.projectName} · </span>
                    {c.title || "(untitled)"}
                    {c.running && <span className="hlp" style={{ margin: 0, marginLeft: 8 }}>· running, skipped</span>}
                    {!c.running && c.unsafe && c.canDiscard && (
                      <span className="hlp" style={{ margin: 0, marginLeft: 8, color: "var(--red)" }}>
                        · discard permanently{c.unsafeReason ? ` (${c.unsafeReason})` : ""}
                      </span>
                    )}
                    {!c.running && c.unsafe && !c.canDiscard && (
                      <span className="hlp" style={{ margin: 0, marginLeft: 8, color: "var(--red)" }}>
                        · has active unmerged work — mark Done before discarding
                      </span>
                    )}
                  </span>
                  <span className="hlp" style={{ margin: 0, whiteSpace: "nowrap" }}>{cleanupLabel(c)}</span>
                  <span style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", width: 72, textAlign: "right" }}>
                    {fmtBytes(c.sizeBytes)}
                  </span>
                </label>
              ))}
            </div>

            {destructiveList.length > 0 && (
              <div className="err-note" style={{ marginTop: 12 }}>
                <strong>Permanent discard:</strong> {destructiveList.length} selected Done task{destructiveList.length === 1 ? " has" : "s have"} unmerged work.
                {" "}Removing {destructiveList.length === 1 ? "it" : "them"} deletes uncommitted edits and the task {destructiveList.length === 1 ? "branch" : "branches"}. This cannot be undone.
              </div>
            )}

            <label className="hlp" style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 12 }}>
              <input type="checkbox" checked={deleteBranch} onChange={(e) => { setDeleteBranch(e.target.checked); setConfirming(false); }} style={{ marginTop: 2 }} />
              <span>
                <strong>Also delete the branch</strong> (off by default). Frees a little more, but you lose the ability to
                view that task&apos;s diff against its original base. Reopening still works — it starts a fresh worktree.
                {destructiveList.length > 0 && " Branches containing unmerged work are always deleted when permanently discarded."}
              </span>
            </label>

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
              <button
                className={`btn ${confirming ? "btn-danger" : "btn-line"}`}
                onClick={prune}
                disabled={busy || selectedList.length === 0}
              >
                {Icon.archive()}{" "}
                {busy
                  ? "Removing…"
                  : confirming
                    ? destructiveList.length > 0
                      ? `Confirm — remove ${selectedList.length}, permanently discard ${destructiveList.length} · reclaim ${fmtBytes(selectedBytes)}`
                      : `Confirm — remove ${selectedList.length} & reclaim ${fmtBytes(selectedBytes)}${deleteBranch ? " + delete branches" : ""}`
                    : `Remove ${selectedList.length} selected · ${fmtBytes(selectedBytes)}`}
              </button>
              {confirming && !busy && (
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>Cancel</button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Future opt-in — the automated path isn't built yet, so it's shown disabled
          to reserve the slot without implying it works. */}
      <div className="field">
        <div className="lab">{Icon.clock()} Auto-prune</div>
        <label className="hlp" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 0, opacity: 0.6 }}>
          <input type="checkbox" disabled />
          Automatically remove worktrees merged more than 30 days ago <span className="opt">— coming soon</span>
        </label>
      </div>
    </>
  );
}

const rowStyle = (header: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 12px",
  borderTop: header ? undefined : "1px solid var(--line, #2a2a2a)",
  background: header ? "var(--panel, rgba(255,255,255,0.03))" : undefined,
  cursor: "default",
});
