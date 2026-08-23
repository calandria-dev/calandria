"use client";

import { Icon } from "../icons";
import { Logo } from "../Logo";
import { Markdown } from "../Markdown";
import { relTime } from "./format";
import { Runbooks } from "./Runbooks";
import { Schedules } from "./Schedules";
import { ErrNote } from "./shared";
import type { AgentsBundle, ProjectRow, RecapInfo } from "./types";

// Shown in the session pane when a project is open but no task is selected.
// Surfaces the auto-generated "where you left off" recap when one exists / is
// brewing; otherwise the plain create-a-task prompt.
export function ProjectLanding({ project, projects, agents, recap, onNewTask, onRefreshRecap, onOpenTask }: {
  project: ProjectRow; projects: ProjectRow[]; agents: AgentsBundle; recap?: RecapInfo;
  onNewTask: () => void; onRefreshRecap: () => void; onOpenTask: (taskId: string) => void;
}) {
  const generating = recap?.generating && !recap?.recap;
  const hasRecap = !!recap?.recap;

  if (generating) {
    return (
      <div className="empty" style={{ margin: "auto" }}>
        <div className="e-ic">{Icon.clock()}</div>
        <div className="e-t">Catching you up…</div>
        <div className="e-s">Recapping where you left off in {project.name}.</div>
        <span className="typing" style={{ marginTop: 14 }}><i /><i /><i /></span>
      </div>
    );
  }

  // Recap fetch/generation failed and there's nothing older to show — offer a
  // retry rather than silently falling through to the plain empty state.
  if (recap?.error && !hasRecap) {
    return (
      <div className="empty" style={{ margin: "auto", maxWidth: 340 }}>
        <div className="e-ic">{Icon.clock()}</div>
        <div className="e-t">Couldn&apos;t catch you up</div>
        <div className="e-s">The recap for {project.name} didn&apos;t load: {recap.error}</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 16 }}>
          <button className="btn btn-line" onClick={onRefreshRecap}>{Icon.restore()} Try again</button>
          <button className="btn btn-accent" onClick={onNewTask}>{Icon.plus()} New task</button>
        </div>
      </div>
    );
  }

  if (hasRecap) {
    return (
      <div className="transcript">
        <div className="tw" style={{ maxWidth: 720 }}>
          <div className="recap-card">
            <div className="recap-head">
              <span className="recap-badge">{Icon.clock()} Where you left off</span>
              <span className="recap-meta">{recap!.recap_at ? `recapped ${relTime(recap!.recap_at)}` : ""}</span>
              <span className="spacer" />
              <button
                className="btn btn-line btn-sm"
                onClick={onRefreshRecap}
                disabled={recap!.generating}
                title="Regenerate this recap from the latest activity"
              >
                {Icon.clear()} {recap!.generating ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {recap!.error && !recap!.generating && (
              <ErrNote style={{ margin: "12px 14px 0" }}>Refresh failed: {recap!.error}</ErrNote>
            )}
            <div className="recap-body"><Markdown>{recap!.recap ?? ""}</Markdown></div>
            <div className="recap-foot">
              <span className="recap-meta">Pick up a task to continue, or start a new one.</span>
              <span className="spacer" />
              <button className="btn btn-accent btn-sm" onClick={onNewTask}>{Icon.plus()} New task</button>
            </div>
          </div>
          <Runbooks project={project} projects={projects} agents={agents} onOpenTask={onOpenTask} />
          <Schedules project={project} agents={agents} />
        </div>
      </div>
    );
  }

  // `.empty`'s centering (used above too) is a single-flex-item auto-margin
  // trick — it only works when its parent both establishes a flex context and
  // has real height to give away, which is why `.session-body` (flex:1;
  // display:flex) was doing the centering directly before Schedules needed
  // somewhere to sit below it. `.transcript`/`.tw` are plain scrolling blocks
  // (shared with the real chat transcript, so their own CSS can't change), so
  // that flex context is rebuilt here with inline styles: `.transcript` becomes
  // the flex column, `.tw` stretches to fill it (`flex: 1`) so there's height
  // to center within, and `.empty`'s own `margin: auto` centers it in
  // whatever's left over — the full height for the brief flash before
  // Schedules' own fetch resolves (it still renders nothing until then), or
  // the space above the card once the card has loaded (Task 12: the card
  // itself always renders now, even for a project with zero schedules, so
  // there's somewhere to click "New schedule" from).
  return (
    <div className="transcript" style={{ display: "flex", flexDirection: "column" }}>
      <div className="tw" style={{ maxWidth: 720, flex: 1, display: "flex", flexDirection: "column" }}>
        <div className="empty void" style={{ margin: "auto" }}>
          <div className="e-ic"><Logo size={40} /></div>
          <div className="e-t">No task selected</div>
          <div className="e-s">Create a task to start an agent session.</div>
          <button className="btn btn-accent" style={{ marginTop: 16 }} onClick={onNewTask}>{Icon.plus()} New task</button>
        </div>
        <Runbooks project={project} projects={projects} agents={agents} onOpenTask={onOpenTask} />
        <Schedules project={project} agents={agents} />
      </div>
    </div>
  );
}
