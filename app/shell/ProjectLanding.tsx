"use client";

import { Icon } from "../icons";
import { Logo } from "../Logo";
import { Markdown } from "../Markdown";
import { relTime } from "./format";
import { Runbooks } from "./Runbooks";
import { Schedules } from "./Schedules";
import { ErrNote } from "./shared";
import { tagIsDone, type AgentsBundle, type ProjectRow, type RecapInfo, type TagRow } from "./types";
import { tagProgress, tagTint } from "./TagChips";

// Shown in the session pane when a project is open but no task is selected.
// Surfaces the auto-generated "where you left off" recap when one exists / is
// brewing; otherwise the plain create-a-task prompt.
export function ProjectLanding({ project, projects, agents, recap, tags, onSelectTag, onNewTask, onRefreshRecap, onOpenTask, mobile }: {
  project: ProjectRow; projects: ProjectRow[]; agents: AgentsBundle; recap?: RecapInfo;
  /** This project's tags with their derived counts — the Tags card below. */
  tags: TagRow[];
  /** Select a tag's chip on the task list/board (null = All). */
  onSelectTag: (tagId: string | null) => void;
  onNewTask: () => void; onRefreshRecap: () => void; onOpenTask: (taskId: string) => void;
  /**
   * Mounted as the phone's project pane rather than in the session column. The
   * "no task selected" placeholder below is dropped there: on desktop it
   * explains an empty half of a split screen, but on a phone this pane was
   * navigated TO on purpose and the placeholder just costs the first screenful
   * — which on a 390px phone is the whole of Runbooks. The pane's own header
   * carries New task, and the task list is one tap back.
   */
  mobile?: boolean;
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
          <TagsCard tags={tags} onSelect={onSelectTag} />
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
  // there's somewhere to click "New schedule" from). With `mobile` there is no
  // `.empty` to center, and the flex column simply stacks the cards from the
  // top — which is what a pane navigated to on purpose should do.
  return (
    <div className="transcript" style={{ display: "flex", flexDirection: "column" }}>
      <div className="tw" style={{ maxWidth: 720, flex: 1, display: "flex", flexDirection: "column" }}>
        {!mobile && (
          <div className="empty void" style={{ margin: "auto" }}>
            <div className="e-ic"><Logo size={40} /></div>
            <div className="e-t">No task selected</div>
            <div className="e-s">Create a task to start an agent session.</div>
            <button className="btn btn-accent" style={{ marginTop: 16 }} onClick={onNewTask}>{Icon.plus()} New task</button>
          </div>
        )}
        <TagsCard tags={tags} onSelect={onSelectTag} />
        <Runbooks project={project} projects={projects} agents={agents} onOpenTask={onOpenTask} />
        <Schedules project={project} agents={agents} />
      </div>
    </div>
  );
}

/**
 * The features in flight in this project — the landing-page half of the chip
 * bar. Only ACTIVE tags: a finished one is history, and the point of this
 * card is "what am I in the middle of". Clicking one lights that tag alone on
 * the task list/board, which is the same selection the chip makes.
 *
 * Renders nothing for a project with no tags, like the chip bar itself — the
 * card costs nothing until the first tag exists.
 */
function TagsCard({ tags, onSelect }: { tags: TagRow[]; onSelect: (id: string) => void }) {
  const active = tags.filter((t) => !tagIsDone(t));
  if (active.length === 0) return null;
  return (
    <div className="tags-card">
      <h3>Tags</h3>
      {active.map((t) => {
        const p = tagProgress(t);
        const pct = p.of > 0 ? (p.done / p.of) * 100 : 0;
        return (
          <button key={t.id} className="tag-row" style={tagTint(t.color)} onClick={() => onSelect(t.id)}
            title={`Show only ${t.name}${t.description ? `\n${t.description}` : ""}`}>
            <div className="tag-head">
              <span className="gc-dot" />
              <strong>{t.name}</strong>
              {/* tagProgress' own empty label is "no tasks yet", which the
                  body below already says — don't print it twice. */}
              {t.counts.total > 0 && <span className="tag-frac mono">{p.label}</span>}
              <span className="spacer" />
              {t.counts.running > 0 && <span className="tag-stat run">{t.counts.running} running</span>}
              {t.counts.awaiting > 0 && <span className="tag-stat need">{t.counts.awaiting} need{t.counts.awaiting === 1 ? "s" : ""} you</span>}
            </div>
            {/* An empty tag is planned, not stalled — say so rather than
                showing a 0% bar that reads like nothing is happening. */}
            {t.counts.total === 0
              ? <div className="tag-desc">No tasks yet</div>
              : <div className="tag-bar"><span style={{ width: `${pct}%` }} /></div>}
            {t.description && <div className="tag-desc">{t.description}</div>}
          </button>
        );
      })}
    </div>
  );
}
