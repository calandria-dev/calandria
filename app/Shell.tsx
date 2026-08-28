"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { Icon } from "./icons";
import { Logo } from "./Logo";
import { TerminalView, type TermApi } from "./Terminal";
import TaskChanges from "./TaskChanges";
import { PROJ_W, TASK_W, DEFAULT_LAYOUT } from "./shell/types";
import { useShell } from "./shell/useShell";
import { ProjectsColumn } from "./shell/ProjectsColumn";
import { TasksColumn } from "./shell/TasksColumn";
import { BoardWorkspace } from "./shell/TaskBoard";
import { SessionView } from "./shell/SessionView";
import { ProjectLanding } from "./shell/ProjectLanding";
import { selectOneTag } from "./shell/TagChips";
import { SettingsView } from "./shell/SettingsView";
import { InsightsView } from "./shell/InsightsView";
import { AppearancePanel } from "./shell/AppearancePanel";
import { ColResize, ColRail, TerminalDrawer, BootSkeleton } from "./shell/Layout";
import { ServicesDrawer } from "./shell/Services";
import { clientFeatures } from "@/lib/features";
import { NewTaskModal, EditTaskModal, MoveTasksModal, TagTasksModal, ContextModal, NewProjectModal, SessionsModal } from "./shell/modals";
import { OnboardingWizard } from "./shell/OnboardingWizard";
import { AgentNudge, AgentAuthBanner } from "./shell/AgentConnect";
import { WelcomeCoach, WelcomeNudge } from "./shell/Welcome";
import { NeedsYouMenu } from "./shell/NeedsYouMenu";
import { PlanUsagePill } from "./shell/PlanUsage";
import { CommandPalette, type PaletteCommand } from "./shell/CommandPalette";
import { MobileTabBar, type MobileTabId } from "./shell/MobileTabBar";

// Below this width the three columns can't coexist, so the workspace collapses to
// one pane at a time (projects → tasks → session) with back affordances. matchMedia
// keeps it in sync with rotation/resize; SSR renders the desktop layout (false) and
// the effect corrects on mount — selection state alone drives which pane shows.
const MOBILE_QUERY = "(max-width: 760px)";
function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return mobile;
}

// Phone terminal: a full-screen sheet (vs. the cramped desktop bottom-drawer) so
// output is actually legible. It's a read-mostly surface — glancing at a dev
// server, reading an error, pasting the Claude login code, tapping the OAuth URL
// — not a place to hand-type code, so input is just the few buttons people need.
function MobileTerminalSheet({ cwd, port, visible, onClose }: { cwd: string; port?: number; visible: boolean; onClose: () => void }) {
  const [epoch, setEpoch] = useState(0);   // bump → fresh shell
  const [fontSize, setFontSize] = useState(13);
  const apiRef = useRef<TermApi | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Pin the sheet to the *visual* viewport so the on-screen keyboard pushes the
  // button-bar and output up rather than covering them. visualViewport shrinks
  // when the keyboard opens; falling back to 100% when it's unavailable.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !visible) return;
    const apply = () => { if (sheetRef.current) sheetRef.current.style.height = `${vv.height}px`; };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => { vv.removeEventListener("resize", apply); vv.removeEventListener("scroll", apply); };
  }, [visible]);

  const send = (d: string) => apiRef.current?.send(d);
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); if (t) send(t); } catch { /* clipboard blocked — long-press paste still works */ }
  };

  return (
    <div ref={sheetRef} className={`mterm${visible ? "" : " hidden"}`}>
      <div className="mterm-bar">
        {Icon.terminal()}
        <span className="mterm-cwd">{cwd || "~ (no working dir)"}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={() => setFontSize((f) => Math.max(9, f - 1))} title="Smaller text" aria-label="Smaller text">A−</button>
        <button className="icon-btn" onClick={() => setFontSize((f) => Math.min(22, f + 1))} title="Larger text" aria-label="Larger text">A+</button>
        <button className="icon-btn" onClick={() => setEpoch((e) => e + 1)} title="Restart shell">{Icon.clear()}</button>
        <button className="icon-btn" onClick={onClose} title="Close terminal (the shell keeps running)">{Icon.x()}</button>
      </div>
      <TerminalView key={epoch} cwd={cwd} port={port} fontSize={fontSize} onReady={(api) => { apiRef.current = api; }} />
      <div className="mterm-keys">
        <button className="mtk" onClick={paste}>Paste</button>
        <span style={{ flex: 1 }} />
        <button className="mtk" onClick={() => send("\x03")} title="Send Ctrl-C">Ctrl-C</button>
        <button className="mtk mtk-enter" onClick={() => send("\r")}>⏎ Enter</button>
      </div>
    </div>
  );
}

export default function Shell() {
  const o = useShell();
  const { project, task, selProj, selTask, layout } = o;
  // Tags by id, for the session header's badges (a task can carry several).
  // Looked up here because both SessionView mounts (list layout, board
  // slide-over) need it.
  const tagsById = useMemo(() => new Map(o.tags.map((t) => [t.id, t])), [o.tags]);
  const isMobile = useIsMobile();
  const features = clientFeatures();
  // Resolves "system" against the OS preference for this quick toggle's icon/
  // label; clicking always pins an explicit mode (bypassing "system"), same as
  // the old binary theme field did. The full palette/mode picker lives in the
  // Appearance popover (AppearancePanel.tsx).
  const resolvedMode =
    o.appearance.mode === "system"
      ? typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : o.appearance.mode;
  const isDark = resolvedMode !== "light";
  const [needsYouOpen, setNeedsYouOpen] = useState(false);
  // Which Settings section to land on when opened programmatically (e.g. the
  // "connect another agent" nudge deep-links to Agents). undefined = default.
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  const openSettings = (sect?: string) => { setSettingsSection(sect); o.setView("settings"); };
  // Drop the open flag if the pill itself disappears (count → 0), so it doesn't
  // silently re-open when a task next starts waiting.
  useEffect(() => { if (o.needsYouTotal === 0) setNeedsYouOpen(false); }, [o.needsYouTotal]);

  // Tab title names the selected project so parallel Calandria tabs are
  // tellable apart; bare "Calandria" (the SSR title) when none is selected.
  useEffect(() => {
    document.title = project ? `Calandria - ${project.name}` : "Calandria";
  }, [project]);

  // ⌘K / Ctrl-K command palette. Same flag as the top-bar omni button, so
  // re-enabling the feature turns on both the visual affordance and the shortcut.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Ids handed up by the task list's multi-select when "Move to project…" is
  // pressed. Held here rather than in the column because every modal is mounted
  // by the shell; the column keeps owning the selection itself, so a task the
  // server refuses stays picked when the modal closes.
  const [bulkMoveIds, setBulkMoveIds] = useState<string[] | null>(null);
  // The same shape for the selection bar's other verb — add/remove tags over a
  // whole selection (app/shell/modals TagTasksModal).
  const [bulkTagIds, setBulkTagIds] = useState<string[] | null>(null);
  const [clearRequest, setClearRequest] = useState<string | null>(null);
  useEffect(() => setClearRequest(null), [selTask]);
  const requestClear = (taskId: string) => setClearRequest(taskId);
  const confirmClear = () => {
    if (!clearRequest) return;
    const taskId = clearRequest;
    setClearRequest(null);
    void o.clearSession(taskId);
  };
  const omniEnabled = features.omniSearch && !isMobile;
  useEffect(() => {
    if (!omniEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [omniEnabled]);

  // Board mode (desktop): the board replaces BOTH the tasks column and the
  // session pane — it owns everything right of the projects sidebar. On mobile
  // the board still renders inside the tasks pane (single-pane navigation).
  const boardMode = o.taskView === "board" && !isMobile && o.view === "workspace" && !!project;
  // The slide-over session panel opens only from an explicit card click — the
  // app's auto-selection paths (landing on a project picks its first task)
  // just highlight the card, they don't pop a panel over the board.
  const [boardPanel, setBoardPanel] = useState(false);
  const openBoardTask = (id: string) => { o.setSelTask(id); setBoardPanel(true); };
  const closeBoardPanel = () => { setBoardPanel(false); o.setSelTask(null); };
  const setTaskView = (v: "list" | "board") => {
    if (v === "board") setBoardPanel(false);
    o.setTaskView(v);
  };

  // ⌘⇧B — flip list/board (sticky, same pref the header toggles write).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setTaskView(o.taskView === "board" ? "list" : "board");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Esc closes the board's slide-over session panel (back to the full board).
  useEffect(() => {
    if (!boardMode || !task || !boardPanel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !paletteOpen) { e.preventDefault(); closeBoardPanel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // On a phone only one of these is mounted at a time; on desktop the same
  // elements sit side by side. Which pane shows is derived purely from the
  // selection state, so the titlebar "needs you" pill (which drives selection)
  // navigates correctly from any level.
  //
  // "project" is the phone's fourth level, and it exists because ProjectLanding
  // had no mount point here at all: on desktop that pane IS "a project is open
  // and no task is selected", but on a phone that same state shows the task
  // list, so Runbooks, Schedules, the Tags card and the recap — every
  // project-level surface ProjectLanding hosts — were unreachable by
  // construction. It's entered by tapping the project name in the task list's
  // header (the same "Project home" control desktop has) and sits between the
  // task list and the session in the Back stack (navHistory.ts).
  const mobilePane: "projects" | "tasks" | "project" | "session" =
    !project ? "projects" : task ? "session" : o.projectHome ? "project" : "tasks";

  // Bottom tab bar (mobile only). Board reuses the drill-down above unchanged;
  // Diffs/Terminals are new full-pane surfaces; Insights mirrors the existing
  // o.view toggle so the URL and the desktop chart icon stay in sync with it.
  const [mobileTab, setMobileTab] = useState<MobileTabId>("board");
  useEffect(() => { if (isMobile && o.view === "insights") setMobileTab("insights"); }, [isMobile, o.view]);
  // Programmatic navigation to a different task (NEED-YOU pill, notification
  // click, ⌘K) changes selTask without going through the tab bar, so a tab
  // left on insights/diffs/terminals swallowed the drill-down silently — the
  // screen never moved. Snap back to the board, where the task is visible.
  const prevSelTaskRef = useRef(selTask);
  useEffect(() => {
    if (isMobile && selTask && selTask !== prevSelTaskRef.current) setMobileTab("board");
    prevSelTaskRef.current = selTask;
  }, [isMobile, selTask]);
  // …and the selTask watch above can't see a jump to the task that's ALREADY
  // selected (needs-you row for the chat you left to look at Diffs), so every
  // goToTask also bumps navEpoch: an explicit "navigate somewhere" signal that
  // snaps the tab back to the board even when no selection changed.
  useEffect(() => {
    if (isMobile && o.navEpoch > 0) setMobileTab("board");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, o.navEpoch]);
  const selectMobileTab = (t: MobileTabId) => {
    // Re-tapping the ACTIVE Board tab from inside a task pops back to the
    // board root — the project's task list — the way a native tab bar pops
    // its stack. It was a dead tap before: the tab was already "board", so
    // nothing changed and the session stayed on screen. Deselecting is
    // enough (mobile skips the desktop auto-pick-first-task landing in
    // useRecaps); the URL/history trap re-mirrors off the new selection.
    // The project-home pane pops the same way, to the same root.
    if (t === "board" && mobileTab === "board" && o.view === "workspace") {
      if (mobilePane === "session") { o.setSelTask(null); return; }
      if (mobilePane === "project") { o.setProjectHome(false); return; }
    }
    setMobileTab(t);
    if (t === "insights") o.setView("insights");
    else if (o.view === "insights" || o.view === "settings") o.setView("workspace");
    if (t === "terminals") o.setTermMounted(true);
  };

  const projectsColumn = (
    <ProjectsColumn
      mobile={isMobile}
      width={layout.projW} onCollapse={() => o.setLayout((l) => ({ ...l, projCollapsed: true }))}
      projects={o.activeProjects} deprecated={o.deprecatedProjects} agents={o.agents.agents} selId={selProj} running={o.running}
      onSelect={o.selectProject} onNew={() => o.setModal("project")} onOpenAppearance={() => o.setAppearanceOpen((t) => !t)}
      onReorder={o.reorderProjects} onRestore={(id) => o.setDeprecated(id, false)}
      settingsActive={o.view === "settings"} onOpenSettings={() => openSettings()}
    />
  );

  const tasksColumn = project && (
    <TasksColumn
      mobile={isMobile}
      onBack={isMobile ? () => window.history.back() : undefined}
      width={layout.taskW}
      onCollapse={() => o.setLayout((l) => ({ ...l, taskCollapsed: true }))}
      project={project} agents={o.agents} tasks={o.realTasks} suggested={o.suggested} tags={o.tags} selTaskId={selTask} running={o.running} blockedBy={o.blockedBy}
      sparklines={o.sparklines}
      loading={o.tasksLoading}
      view={o.taskView} onSetView={setTaskView} onMoveTask={o.moveTask}
      onSelectTask={o.setSelTask} onNewTask={() => o.setModal("task")} onEditContext={() => o.setModal("context")}
      onShowSessions={() => o.setModal("sessions")} onShowRecap={o.showProjectHome} onEditTask={o.setEditId}
      onStartSuggestion={o.startSuggestion} onAcceptSuggestion={o.acceptSuggestion} onDismissSuggestion={o.dismissSuggestion}
      onSnoozeTask={o.snoozeTask} onUnsnoozeTask={o.unsnoozeTask} onAckRun={o.ackRun}
      onBulkMove={setBulkMoveIds}
      onBulkTag={setBulkTagIds}
      baseBranchTick={o.baseBranchTick}
    />
  );

  const sessionColumn = (
    <div className="col col-session">
      {project?.seeded === 1 && !isMobile && <WelcomeCoach />}
      <div className="session-body">
        {task && project ? (
          <SessionView
            key={task.id}
            mobile={isMobile}
            onBack={isMobile ? () => window.history.back() : undefined}
            project={project} task={task} tagsById={tagsById} agents={o.agents} messages={o.messages} running={o.running.has(task.id)} blockedBy={o.blockedBy.get(task.id)}
            transcriptLoading={o.transcriptLoading}
            onSend={(text) => o.runTurn(task.id, text, false)}
            onStart={() => o.runTurn(task.id, "", true)}
            onStop={() => o.stopTurn(task.id)}
            onClear={() => requestClear(task.id)} clearConfirming={clearRequest === task.id} onConfirmClear={confirmClear} onCancelClear={() => setClearRequest(null)} onEdit={() => o.setEditId(task.id)}
            onReconnect={() => openSettings("agents")}
            onSetStatus={o.setStatus} onSetPriority={o.setPriority} onSetModel={o.setModel}
            onSetReasoning={o.setReasoning} onSetPermission={o.setPermission} onSetSendContext={o.setSendContext} onSetAutoStart={o.setAutoStart}
                onSnooze={(until) => o.snoozeTask(task.id, until)} onUnsnooze={() => o.unsnoozeTask(task.id)}
            onQueueStart={(at) => o.queueStart(task.id, at)} onCancelQueuedStart={() => o.cancelQueuedStart(task.id)}
            onResolveWithAI={o.resolveConflictsWithAI}
            onMerged={o.onMerged}
            onPrCreated={o.onPrCreated}
            onAnswer={(askId, questions, answers) => o.answerQuestion(task.id, askId, questions, answers)}
            onDecidePermission={(permId, decision, note) => o.decidePermission(task.id, permId, decision, note)}
            onCancelQueued={(pendingId) => o.cancelQueued(task.id, pendingId)}
            railW={layout.railW}
            onRailWidth={(w) => o.setLayout((l) => ({ ...l, railW: w }))}
            onRailReset={() => o.setLayout((l) => ({ ...l, railW: DEFAULT_LAYOUT.railW }))}
            railCollapsed={layout.railCollapsed}
            onRailCollapse={() => o.setLayout((l) => ({ ...l, railCollapsed: true }))}
            onRailExpand={() => o.setLayout((l) => ({ ...l, railCollapsed: false }))}
          />
        ) : project ? (
          <ProjectLanding
            project={project}
            projects={o.activeProjects}
            agents={o.agents}
            recap={o.recaps[project.id]}
            tags={o.tags}
            onSelectTag={(id) => selectOneTag(project.id, id)}
            onNewTask={() => o.setModal("task")}
            onRefreshRecap={() => o.fetchRecap(project.id, true)}
            onOpenTask={o.setSelTask}
          />
        ) : (
          <div className="empty void" style={{ margin: "auto" }}>
            <div className="e-ic"><Logo size={40} /></div>
            <div className="e-t">No task selected</div>
            <div className="e-s">Create a task to start an agent session.</div>
          </div>
        )}
      </div>
      {/* Managed services: desktop only, and that is ACCIDENTAL, not a decision
          — the same class of gap as the one this pane fixes. `.tb-actions` is
          `display:none` on a phone (globals.css) so the Services button isn't
          even rendered there, and this gate then declines to mount the drawer,
          so a phone has no way to start, stop or read the log of a project's
          dev server. Unlike the terminal below there is no mobile substitute.
          It is left alone here rather than half-fixed because the drawer needs
          real work to fit a phone — a mouse-only drag-to-resize handle and a
          side-by-side service-list/log split — and that is its own task, not a
          rider on this one. When it is done, the project pane above is where it
          belongs: it is the project-level surface a phone now has. */}
      {project && features.services && o.servicesMounted && !isMobile && (
        <ServicesDrawer
          key={`svc-${project.id}`}
          projectId={project.id}
          hasConfig={!!(project.dev_command || project.setup_command || project.test_command)}
          visible={o.servicesOpen}
          height={o.servicesHeight}
          onClose={() => o.setServicesOpen(false)}
          onResize={o.setServicesHeight}
        />
      )}
      {/* Terminal: desktop only ON PURPOSE — a phone gets MobileTerminalSheet
          (mounted at the bottom of this file), a full-screen sheet with real
          text sizing and a Paste/Ctrl-C/Enter key row, plus its own Terminals
          tab. This bottom drawer is the cramped desktop form; mounting both
          would put two live shells in the same project. Deliberate omission. */}
      {project && o.termMounted && !isMobile && (
        <TerminalDrawer
          key={project.id}
          cwd={project.repo_path}
          taskDir={task?.worktree_path || undefined}
          taskTitle={task?.title}
          port={project.port}
          visible={o.termOpen}
          height={o.termHeight}
          onClose={() => o.setTermOpen(false)}
          onResize={o.setTermHeight}
        />
      )}
    </div>
  );

  // Board mode's full-workspace surface: header + board, with the slide-over
  // session panel and the project drawers mounted on top (so the titlebar's
  // Services/Terminal toggles keep working while the board is up).
  const boardWorkspace = project && (
    <BoardWorkspace
      project={project} agents={o.agents} tasks={o.realTasks} suggested={o.suggested} tags={o.tags}
      selTaskId={selTask} running={o.running} blockedBy={o.blockedBy} sparklines={o.sparklines} loading={o.tasksLoading}
      onSetView={setTaskView} onMoveTask={o.moveTask}
      onSelectTask={openBoardTask} onNewTask={() => o.setModal("task")} onEditContext={() => o.setModal("context")}
      onShowSessions={() => o.setModal("sessions")} onEditTask={o.setEditId}
      onStartSuggestion={o.startSuggestion} onAcceptSuggestion={o.acceptSuggestion} onDismissSuggestion={o.dismissSuggestion}
      onSnoozeTask={o.snoozeTask} onUnsnoozeTask={o.unsnoozeTask} onAckRun={o.ackRun}
    >
      {task && boardPanel && (
        <>
          <div className="bpanel-scrim" onClick={closeBoardPanel} />
          <div className="bpanel">
            <div className="bpanel-bar">
              <button className="icon-btn" title="Expand to list + chat layout" onClick={() => o.setTaskView("list")}>{Icon.external()}</button>
              <span className="bp-hint">esc returns to the board</span>
              <span className="spacer" />
              <button className="icon-btn" title="Back to board" onClick={closeBoardPanel}>{Icon.x()}</button>
            </div>
            <div className="session-body">
              <SessionView
                key={task.id}
                project={project} task={task} tagsById={tagsById} agents={o.agents} messages={o.messages} running={o.running.has(task.id)} blockedBy={o.blockedBy.get(task.id)}
                transcriptLoading={o.transcriptLoading}
                onSend={(text) => o.runTurn(task.id, text, false)}
                onStart={() => o.runTurn(task.id, "", true)}
                onStop={() => o.stopTurn(task.id)}
                onClear={() => requestClear(task.id)} clearConfirming={clearRequest === task.id} onConfirmClear={confirmClear} onCancelClear={() => setClearRequest(null)} onEdit={() => o.setEditId(task.id)}
                onReconnect={() => openSettings("agents")}
                onSetStatus={o.setStatus} onSetPriority={o.setPriority} onSetModel={o.setModel}
                onSetReasoning={o.setReasoning} onSetPermission={o.setPermission} onSetSendContext={o.setSendContext} onSetAutoStart={o.setAutoStart}
                onSnooze={(until) => o.snoozeTask(task.id, until)} onUnsnooze={() => o.unsnoozeTask(task.id)}
                onQueueStart={(at) => o.queueStart(task.id, at)} onCancelQueuedStart={() => o.cancelQueuedStart(task.id)}
                onResolveWithAI={o.resolveConflictsWithAI}
                onMerged={o.onMerged}
                onPrCreated={o.onPrCreated}
                onAnswer={(askId, questions, answers) => o.answerQuestion(task.id, askId, questions, answers)}
                onDecidePermission={(permId, decision, note) => o.decidePermission(task.id, permId, decision, note)}
                onCancelQueued={(pendingId) => o.cancelQueued(task.id, pendingId)}
                railW={layout.railW}
                onRailWidth={(w) => o.setLayout((l) => ({ ...l, railW: w }))}
                onRailReset={() => o.setLayout((l) => ({ ...l, railW: DEFAULT_LAYOUT.railW }))}
                railCollapsed={layout.railCollapsed}
                onRailCollapse={() => o.setLayout((l) => ({ ...l, railCollapsed: true }))}
                onRailExpand={() => o.setLayout((l) => ({ ...l, railCollapsed: false }))}
              />
            </div>
          </div>
        </>
      )}
      {features.services && o.servicesMounted && (
        <ServicesDrawer
          key={`svc-${project.id}`}
          projectId={project.id}
          hasConfig={!!(project.dev_command || project.setup_command || project.test_command)}
          visible={o.servicesOpen}
          height={o.servicesHeight}
          onClose={() => o.setServicesOpen(false)}
          onResize={o.setServicesHeight}
        />
      )}
      {o.termMounted && (
        <TerminalDrawer
          key={project.id}
          cwd={project.repo_path}
          taskDir={task?.worktree_path || undefined}
          taskTitle={task?.title}
          port={project.port}
          visible={o.termOpen}
          height={o.termHeight}
          onClose={() => o.setTermOpen(false)}
          onResize={o.setTermHeight}
        />
      )}
    </BoardWorkspace>
  );

  // Mobile project pane: ProjectLanding with a header of its own. On desktop
  // this component lives in the session column, framed by the task list beside
  // it; on a phone that frame is a different pane, so the back chevron (to the
  // task list, one Back level — navHistory.ts), the project name and the New
  // task action have to travel with the pane. Everything below the header is
  // the same component desktop renders, so Runbooks/Schedules/Tags/recap
  // can't drift between the two.
  const projectColumn = project && (
    <div className="col col-project">
      <div className="proj-banner">
        <div className="pb-row">
          <button className="mobile-back" onClick={() => o.setProjectHome(false)} title="Back to tasks" aria-label="Back to tasks">
            {Icon.chevRight({ style: { transform: "rotate(180deg)" } })}
          </button>
          <span className="pb-home static">
            <span className="pb-pic" style={{ background: project.color }}>{project.name[0]}</span>
            <span className="pb-name">{project.name}</span>
          </span>
          <button className="btn btn-line btn-sm" onClick={() => o.setModal("sessions")} title="Agent sessions run under this project">{Icon.clock()} Sessions</button>
          <button className="btn btn-line btn-sm" onClick={() => o.setModal("task")}>{Icon.plus()} Task</button>
        </div>
      </div>
      <div className="session-body">
        <ProjectLanding
          mobile
          project={project}
          projects={o.activeProjects}
          agents={o.agents}
          recap={o.recaps[project.id]}
          tags={o.tags}
          // A tag chip is a filter on the TASK LIST, so picking one has to
          // leave this pane — otherwise the tap looks dead on a phone.
          onSelectTag={(id) => { selectOneTag(project.id, id); o.setProjectHome(false); }}
          onNewTask={() => o.setModal("task")}
          onRefreshRecap={() => o.fetchRecap(project.id, true)}
          onOpenTask={o.setSelTask}
        />
      </div>
    </div>
  );

  // Mobile Diffs tab: the same TaskChanges the desktop rail mounts, full-pane
  // and task-scoped, wired to onSend the same way SessionView does.
  const diffsColumn = (
    <div className="col col-diffs">
      {task && project ? (
        <TaskChanges
          taskId={task.id} projectId={project.id} running={o.running.has(task.id)} prUrl={task.pr_url}
          onMerged={o.onMerged} onPrCreated={o.onPrCreated}
          onSend={(text) => o.runTurn(task.id, text, false)}
          onResolveWithAI={o.resolveConflictsWithAI}
        />
      ) : (
        <div className="empty void" style={{ margin: "auto" }}>
          <div className="e-ic"><Logo size={40} /></div>
          <div className="e-t">No task selected</div>
          <div className="e-s">Select a task to see its changes.</div>
        </div>
      )}
    </div>
  );

  const insightsColumn = (
    <InsightsView agents={o.agents} onClose={() => o.setView("workspace")} onOpenSettings={openSettings} />
  );

  const settingsColumn = (
    <SettingsView
      key={settingsSection ?? "default"}
      settings={o.settings}
      setSetting={o.setSetting}
      appearance={o.appearance}
      setAppearance={o.setAppearance}
      appDefaults={o.appDefaults}
      setAppDefault={o.setAppDefault}
      agents={o.agents}
      onAgentsRefresh={o.refreshAgents}
      onReset={o.resetSettings}
      onRerunSetup={o.rerunOnboarding}
      onClose={() => o.setView("workspace")}
      initialSection={settingsSection}
    />
  );

  return (
    <div className={`app${isMobile ? " mobile" : ""}`}>
      <div className="titlebar">
        <div className="tb-left">
          <div className="tb-logo" title="Calandria">
            <Logo size={17.5} />
            <span className="tb-word">Calandria</span>
          </div>
          {!isMobile && (
            <>
              <span className="tb-div" />
              <div className="tb-crumb">
                <span className="cz">fleet</span><span className="cs">/</span>
                <span className="cn">{o.view === "insights" ? "insights" : project ? project.name : "—"}</span>
              </div>
            </>
          )}
        </div>

        {omniEnabled && (
          <button className="tb-omni" onClick={() => setPaletteOpen(true)} title="Command palette: jump to a project, session, or command">
            <span className="omni-ic">{Icon.search()}</span>
            <span className="omni-txt">Jump to project, session, or command…</span>
            <span className="omni-k">⌘K</span>
          </button>
        )}

        <div className="tb-right">
          <PlanUsagePill />
          {o.needsYouTotal > 0 && (
            <div style={{ position: "relative" }}>
              <button
                className="needs-you-pill"
                onClick={(e) => { e.stopPropagation(); setNeedsYouOpen((v) => !v); }}
                title="Pick a task waiting on your input"
              >
                <span className="ny-dot" />
                {o.needsYouTotal} NEED YOU
              </button>
              {needsYouOpen && (
                <NeedsYouMenu
                  onJump={(projectId, taskId) => o.goToTask(projectId, taskId)}
                  onClose={() => setNeedsYouOpen(false)}
                />
              )}
            </div>
          )}
          {isMobile && project && (
            <button
              className={`tb-icon${o.termOpen ? " on" : ""}`}
              title="Terminal (runs in the project's working dir)" aria-label="Terminal"
              onClick={() => { o.setTermMounted(true); o.setTermOpen((t) => !t); }}
            >
              {Icon.terminal()}
            </button>
          )}

          <div className="tb-actions">
            {features.services && (
              <button
                className={`tb-btn${o.servicesOpen ? " on" : ""}`}
                disabled={!project}
                title={project ? "Toggle the project's managed services (dev server, setup, test)" : "Select a project first"}
                onClick={() => { if (!project) return; o.setServicesMounted(true); o.setServicesOpen((s) => !s); }}
              >
                {Icon.sliders()} Services
              </button>
            )}
            <button
              className={`tb-btn${o.termOpen ? " on" : ""}`}
              disabled={!project}
              title={project ? "Toggle terminal (project working dir: switch it to the selected task's worktree from the drawer)" : "Select a project first"}
              onClick={() => { if (!project) return; o.setTermMounted(true); o.setTermOpen((t) => !t); }}
            >
              {Icon.terminal()} Terminal
            </button>
            <button className="tb-btn" onClick={() => o.setAppearanceOpen((t) => !t)} title="Appearance">{Icon.sliders()} Appearance</button>
          </div>

          <button
            className={`tb-icon${o.view === "insights" ? " on" : ""}`}
            title="Insights: spend, tokens, tasks shipped, code merged" aria-label="Insights"
            onClick={() => o.setView(o.view === "insights" ? "workspace" : "insights")}
          >
            {Icon.chart()}
          </button>
          <button className="tb-icon" title={isDark ? "Switch to light theme" : "Switch to dark theme"} aria-label="Toggle theme" onClick={() => o.setAppearance("mode", isDark ? "light" : "dark")}>
            {isDark ? Icon.sun() : Icon.moon()}
          </button>
        </div>
      </div>

      {/* An agent's login died — nothing can run until it's reconnected, and that
          is true for every project, so it lives above the whole workspace rather
          than inside the task that happened to hit it first. */}
      <AgentAuthBanner broken={o.brokenAgents} onReconnect={() => openSettings("agents")} />

      <div className={`body${isMobile ? " mobile" : ""}`}>
        {o.bootError ? (
          // The very first fetch failed — nothing to render behind this, so a
          // centered retry beats an empty workspace that looks "hung".
          <div className="empty" style={{ margin: "auto" }}>
            <div className="e-ic">{Icon.bolt()}</div>
            <div className="e-t">Couldn&apos;t reach the workspace</div>
            <div className="e-s">{o.bootError}</div>
            <button className="btn btn-line" style={{ marginTop: 16 }} onClick={o.retryBoot}>{Icon.restore()} Retry</button>
          </div>
        ) : !o.booted ? (
          <BootSkeleton mobile={isMobile} />
        ) : isMobile ? (
          o.view === "settings" ? settingsColumn
            : mobileTab === "insights" ? insightsColumn
            : mobileTab === "diffs" ? diffsColumn
            : mobileTab === "terminals" ? null /* the full-screen terminal sheet below covers this pane */
            : mobilePane === "projects" ? projectsColumn
            : mobilePane === "tasks" ? tasksColumn
            : mobilePane === "project" ? projectColumn
            : sessionColumn
        ) : (
          <>
            {layout.projCollapsed ? (
              <ColRail label="Projects" onExpand={() => o.setLayout((l) => ({ ...l, projCollapsed: false }))} />
            ) : (
              <>
                {projectsColumn}
                <ColResize
                  min={PROJ_W.min} max={PROJ_W.max}
                  onWidth={(w) => o.setLayout((l) => ({ ...l, projW: w }))}
                  onReset={() => o.setLayout((l) => ({ ...l, projW: DEFAULT_LAYOUT.projW }))}
                />
              </>
            )}

            {o.view === "settings" ? settingsColumn : o.view === "insights" ? insightsColumn : boardMode ? boardWorkspace : (
              <>
                {project ? (
                  layout.taskCollapsed ? (
                    <ColRail label="Tasks" task onExpand={() => o.setLayout((l) => ({ ...l, taskCollapsed: false }))} />
                  ) : (
                    <>
                      {tasksColumn}
                      <ColResize
                        min={TASK_W.min} max={TASK_W.max}
                        onWidth={(w) => o.setLayout((l) => ({ ...l, taskW: w }))}
                        onReset={() => o.setLayout((l) => ({ ...l, taskW: DEFAULT_LAYOUT.taskW }))}
                      />
                    </>
                  )
                ) : (
                  // First-run (or everything deprecated): make the empty shell a
                  // doorway, not a dead end — explain what a project is and offer
                  // the create action right here.
                  <div className="col col-tasks">
                    <div className="empty void" style={{ margin: "auto", maxWidth: 340 }}>
                      <div className="e-ic"><Logo size={48} /></div>
                      <div className="e-t">{o.projects.length > 0 ? "No active projects" : "No projects yet"}</div>
                      <div className="e-s">
                        {o.projects.length > 0
                          ? "Everything is deprecated. Restore a project from the sidebar, or start a new one."
                          : "Each project is an app you're building: its own working directory, context, and agent sessions."}
                      </div>
                      <button className="btn btn-accent" style={{ marginTop: 16 }} onClick={() => o.setModal("project")}>
                        {Icon.plus()} {o.projects.length > 0 ? "New project" : "Create your first project"}
                      </button>
                    </div>
                  </div>
                )}

                {sessionColumn}
              </>
            )}
          </>
        )}
      </div>

      {isMobile && o.booted && !o.bootError && (
        <MobileTabBar active={o.view === "settings" ? null : mobileTab} onSelect={selectMobileTab} />
      )}

      {o.modal === "task" && project && <NewTaskModal project={project} agents={o.agents} tasks={o.realTasks} tags={o.tags} onClose={() => o.setModal(null)} onCreate={o.createTask} onCreateTag={o.createTag} onOpenSetup={o.rerunOnboarding} />}
      {o.editId && o.tasks.find((t) => t.id === o.editId) && (
        <EditTaskModal task={o.tasks.find((t) => t.id === o.editId)!} tasks={o.realTasks} tags={o.tags} projects={o.activeProjects} agents={o.agents} onClose={() => o.setEditId(null)} onSave={o.saveTask} onDelete={o.removeTask} onMove={o.moveTaskToProject} onCreateTag={o.createTag} onOpenSetup={o.rerunOnboarding} />
      )}
      {bulkMoveIds && project && (
        <MoveTasksModal
          // Resolved from the live rows in list order, so the modal shows what
          // the tray shows — and so a task that vanished under the selection
          // (moved in another tab, deleted) simply isn't in it.
          selected={o.tasks.filter((t) => bulkMoveIds.includes(t.id))}
          tasks={o.tasks} projects={o.activeProjects} agents={o.agents} sourceProjectId={project.id}
          onClose={() => setBulkMoveIds(null)} onMove={o.moveTasksToProject}
          onMoved={(moved) => setBulkMoveIds((ids) => (ids ?? []).filter((id) => !moved.includes(id)))}
        />
      )}
      {bulkTagIds && bulkTagIds.length > 0 && project && (
        <TagTasksModal
          // Resolved from the live rows, like the move modal's: a task that
          // vanished under the selection simply isn't in it.
          selected={o.tasks.filter((t) => bulkTagIds.includes(t.id))}
          tags={o.tags}
          onClose={() => setBulkTagIds(null)}
          onApply={o.tagTasks}
          onCreateTag={o.createTag}
        />
      )}
      {o.modal === "context" && project && <ContextModal project={project} agents={o.agents} onSetDefaultAgent={o.setProjectDefaultAgent} onClose={() => o.setModal(null)} onSave={o.saveContext} onDelete={() => o.removeProject(project.id)} onDeprecate={() => o.setDeprecated(project.id, true)} />}
      {o.modal === "project" && <NewProjectModal onClose={() => o.setModal(null)} onCreate={o.createProject} />}
      {o.modal === "sessions" && project && (
        <SessionsModal
          project={project}
          onClose={() => o.setModal(null)}
          onJump={(taskId) => { o.setSelTask(taskId); o.setModal(null); }}
        />
      )}

      {/* ⌘K palette. Commands are assembled here (not inside the palette) so each
          row can close over the same handlers the top bar and rails use; rows that
          need a project/task are simply omitted when there isn't one. */}
      {paletteOpen && (
        <CommandPalette
          projects={o.activeProjects}
          commands={([
            { id: "new-project", label: "New project", keywords: "create add repo", icon: Icon.plus(), run: () => o.setModal("project") },
            project && { id: "new-task", label: "New task", hint: `in ${project.name}`, keywords: "new session create start", icon: Icon.plus(), run: () => o.setModal("task") },
            // One row per runbook rather than a "Run runbook…" row that opens a
            // picker: the whole value of a saved recipe is ⌘K, three letters,
            // Enter, and a picker costs an extra keystroke and a second list to
            // read — enough to send someone back to retyping the prompt.
            ...(project ? o.runbooks.map((r): PaletteCommand => ({
              id: `runbook-${r.id}`,
              label: `Run: ${r.name}`,
              hint: r.description || `in ${project.name}`,
              keywords: `runbook dispatch ${r.name} ${r.description}`,
              icon: Icon.play(),
              run: () => void o.runRunbook(r.id),
            })) : []),
            project && { id: "toggle-task-view", label: o.taskView === "board" ? "Show tasks as list" : "Show tasks as board", hint: "⌘⇧B", keywords: "kanban board list columns view", icon: o.taskView === "board" ? Icon.list() : Icon.board(), run: () => setTaskView(o.taskView === "board" ? "list" : "board") },
            { id: "toggle-theme", label: "Toggle theme", hint: isDark ? "switch to light" : "switch to dark", keywords: "dark light mode appearance", icon: isDark ? Icon.sun() : Icon.moon(), run: () => o.setAppearance("mode", isDark ? "light" : "dark") },
            { id: "toggle-text-width", label: o.appearance.wide === "1" ? "Use reading-width text" : "Use full-width text", hint: o.appearance.wide === "1" ? "760px measure" : "fill the pane", keywords: "wide full width narrow measure transcript column appearance", icon: Icon.sliders(), run: () => o.setAppearance("wide", o.appearance.wide === "1" ? "0" : "1") },
            { id: "open-settings", label: "Open Settings", keywords: "preferences defaults setup", icon: Icon.gear(), run: () => openSettings() },
            { id: "open-insights", label: "Open Insights", keywords: "usage spend cost tokens analytics dashboard metrics stats", icon: Icon.chart(), run: () => o.setView("insights") },
            { id: "connect-agent", label: "Connect an agent", keywords: "codex claude agent connect login subscription", icon: Icon.bolt(), run: () => openSettings("agents") },
            { id: "open-appearance", label: "Open Appearance", keywords: "appearance density theme dark light mode width", icon: Icon.sliders(), run: () => o.setAppearanceOpen(true) },
            project && features.services && { id: "toggle-services", label: "Toggle Services", hint: o.servicesOpen ? "hide" : "show", keywords: "dev server setup test drawer", icon: Icon.sliders(), run: () => { o.setServicesMounted(true); o.setServicesOpen((s) => !s); } },
            project && { id: "toggle-terminal", label: "Toggle Terminal", hint: o.termOpen ? "hide" : "show", keywords: "shell console pty", icon: Icon.terminal(), run: () => { o.setTermMounted(true); o.setTermOpen((t) => !t); } },
            task && task.started === 1 && !o.running.has(task.id) && { id: "clear-session", label: "/clear current session", hint: task.title, keywords: "new session restart fresh context compact", icon: Icon.clear(), run: () => requestClear(task.id) },
          ] as (PaletteCommand | false | null)[]).filter((c): c is PaletteCommand => !!c)}
          onPickProject={o.selectProject}
          onPickTask={o.goToTask}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {o.appearanceOpen && <AppearancePanel appearance={o.appearance} setAppearance={o.setAppearance} onClose={() => o.setAppearanceOpen(false)} />}

      {/* Phone terminal lives as a full-screen sheet over everything. Kept mounted
          (hidden) while a project is selected so a dev server survives pane hops. */}
      {/* Also doubles as the Terminals tab's full pane: it's already a fixed,
          full-screen sheet (z-index above the tab bar), so opening it here is
          the same "mount it open as a pane" the tab needs — no second instance
          of the terminal (and its live shell) gets created. */}
      {isMobile && project && o.termMounted && (
        <MobileTerminalSheet
          key={project.id} cwd={project.repo_path} port={project.port}
          visible={o.termOpen || mobileTab === "terminals"}
          onClose={() => { o.setTermOpen(false); setMobileTab((t) => (t === "terminals" ? "board" : t)); }}
        />
      )}

      {/* First-run onboarding — a full-screen wizard over the (empty) workspace
          on a fresh instance, or when re-run from Settings. */}
      {o.wizardOpen && o.onboarding && (
        <OnboardingWizard initial={o.onboarding} onFinish={o.finishWizard} />
      )}

      {/* Optional post-setup nudge to connect a second agent (Codex). Only once
          the required first-run wizard is done, and never stacked on the wizard
          or the tutorial-payoff modal. Dismissible once (localStorage). */}
      {o.onboarding?.complete && !o.wizardOpen && !o.nudge && (
        <AgentNudge ready onConnect={() => openSettings("agents")} />
      )}

      {/* Post-tutorial payoff: fires once the seeded "Welcome" task is merged. */}
      {o.nudge && (
        <WelcomeNudge
          onClose={() => o.setNudge(false)}
          onCreateProject={() => { o.setNudge(false); o.setModal("project"); }}
        />
      )}
    </div>
  );
}
