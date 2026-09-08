"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import type { BaseBranchResp } from "./types";
import { jget } from "./api";
import { ErrDetail } from "./shared";

/**
 * How the project's local base branch stands against its remote, shown under the
 * project header.
 *
 * Work can land on the remote outside the merge button (a PR merged on
 * GitHub, a teammate's push), leaving local `main` behind. New task
 * worktrees are cut from the fetched remote tip, but the local branch is
 * only ever advanced by an explicit action here, never automatically.
 *
 * Renders nothing when there is no remote or the branch is in sync.
 */
export function BaseBranchBanner({ projectId, refreshKey }: { projectId: string; refreshKey?: number }) {
  const [st, setSt] = useState<BaseBranchResp | null>(null);
  const [busy, setBusy] = useState<"" | "ff" | "push">("");
  const [err, setErr] = useState("");
  const [detail, setDetail] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setSt(await jget<BaseBranchResp>(`/api/projects/${projectId}/base-branch`));
    } catch {
      setSt(null); // a status we can't read is not worth a banner of its own
    }
  }, [projectId]);

  // On project open (the "fetch on project open" half of keeping worktrees
  // fresh), and again whenever a merge has moved the local base branch.
  useEffect(() => {
    setSt(null);
    setErr("");
    setDetail(undefined);
    void load();
  }, [load, refreshKey]);

  const act = async (action: "fast-forward" | "push") => {
    setBusy(action === "push" ? "push" : "ff");
    setErr("");
    setDetail(undefined);
    try {
      const r = await fetch(`/api/projects/${projectId}/base-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setErr(j?.error || `${r.status} ${r.statusText}`);
        setDetail(j?.detail);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
      void load();
    }
  };

  if (!st?.hasRemote) return null;

  const base = st.baseBranch || "the base branch";
  const label = st.label || "the remote";
  const behind = st.behind ?? 0;
  const ahead = st.ahead ?? 0;
  const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

  // A fetch that failed only matters when there is nothing better to show.
  // Once a fetch has succeeded, the counts below stay meaningful, so a later
  // blip (offline for the afternoon) should not show as an error here.
  if (st.fetchError && !st.fetchedAt)
    return <div className="bb-banner quiet">{Icon.cloudOff()} Couldn&apos;t reach {label}. {base} may be out of date.</div>;

  // No local ref for the base branch at all: a standing misconfiguration.
  if (st.baseMissing)
    return <div className="bb-banner warn">{Icon.cloudOff()} {base} has no branch in this checkout, so it can&apos;t be compared with {label}.</div>;

  if (st.unknown)
    return <div className="bb-banner quiet">{Icon.cloudOff()} Couldn&apos;t compare {base} with {label}. This looks like a shallow clone.</div>;

  if (behind === 0 && ahead === 0) return null;

  const diverged = st.diverged || (behind > 0 && ahead > 0);

  return (
    <>
      <div className={`bb-banner${diverged ? " warn" : ""}`}>
        <span className="bb-msg">
          {diverged
            ? `${base} and ${label} have diverged: ${commits(ahead)} here, ${commits(behind)} there`
            : behind > 0
              ? `${base} is ${commits(behind)} behind ${label}`
              : `${base} is ${commits(ahead)} ahead of ${label}`}
        </span>
        <span className="bb-spacer" />
        {err && <span className="bb-err" title={err}>{err}</span>}
        {!diverged && behind > 0 && (
          <button className="tc-btn primary" onClick={() => act("fast-forward")} disabled={!!busy}
            title={`Fast-forward ${base} to ${label}. New tasks already start from ${label}; this catches up your own checkout.`}>
            {busy === "ff" ? "Catching up…" : "Fast-forward"}
          </button>
        )}
        {!diverged && ahead > 0 && behind === 0 && (
          <button className="tc-btn" onClick={() => act("push")} disabled={!!busy} title={`Push ${base} to ${label}`}>
            {busy === "push" ? "Pushing…" : "Push"}
          </button>
        )}
        {diverged && (
          <span className="bb-hint" title={`Merge or rebase ${base} yourself. The app only ever fast-forwards it.`}>
            resolve this in your checkout
          </span>
        )}
      </div>
      {err && detail && <ErrDetail detail={detail} />}
    </>
  );
}
