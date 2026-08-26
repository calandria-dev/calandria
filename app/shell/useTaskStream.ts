"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { TaskStreamEvent, ToolData, AskAnswers, PermissionOutcome } from "@/lib/types";
import { jget } from "./api";
import { contextPct } from "./format";
import { capsFor } from "./agents";
import type { AgentsBundle, Msg, ProjectRow, TaskRow } from "./types";

// Owns the per-task transcript state (msgsByTask) plus the live SSE consumption:
// the snapshot-then-tail EventSource and the message mutators that apply each
// server event. The turn itself runs server-side, detached from any connection.
export function useTaskStream({ selTask, selProjRef, agentsRef, setTaskRunning, setTasks, setProjects, loadTasks }: {
  selTask: string | null;
  selProjRef: MutableRefObject<string | null>;
  agentsRef: MutableRefObject<AgentsBundle>;
  setTaskRunning: (id: string, on: boolean) => void;
  setTasks: React.Dispatch<React.SetStateAction<TaskRow[]>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectRow[]>>;
  loadTasks: (projectId: string, selectFirst?: boolean) => Promise<void>;
}) {
  const [msgsByTask, setMsgsByTask] = useState<Record<string, Msg[]>>({});

  // Everything still parked on the user, per task — AskUserQuestion cards and
  // tool-permission prompts alike. One assistant message can park several at
  // once, and the "Needs your input" flag must stay up until the last one is
  // settled — mirrors openAsks in lib/runner.ts.
  const openAsksRef = useRef<Record<string, Set<string>>>({});

  const appendMsg = (taskId: string, m: Msg) =>
    setMsgsByTask((prev) => ({ ...prev, [taskId]: [...(prev[taskId] ?? []), m] }));

  // Mark an AskUserQuestion message (matched by tool id) as answered. Matches on
  // the id embedded in the content too, so it works for reloaded messages whose
  // in-memory toolId was lost.
  const setAnswerOnMsg = (taskId: string, askId: string, answers: AskAnswers) =>
    setMsgsByTask((prev) => {
      const arr = prev[taskId] ?? [];
      return {
        ...prev,
        [taskId]: arr.map((m) => {
          if (m.role !== "tool") return m;
          try {
            const d = JSON.parse(m.content) as ToolData;
            if (m.toolId !== askId && d.ask?.id !== askId) return m;
            d.ask = { id: d.ask?.id ?? askId, questions: d.ask?.questions ?? [], answers };
            return { ...m, content: JSON.stringify(d) };
          } catch {
            return m;
          }
        }),
      };
    });

  // Settle a permission card (matched by tool id, or the id embedded in the
  // content for reloaded messages) — the same shape of update as an answered
  // ask, one card at a time.
  const setOutcomeOnMsg = (taskId: string, permId: string, outcome: PermissionOutcome) =>
    setMsgsByTask((prev) => {
      const arr = prev[taskId] ?? [];
      return {
        ...prev,
        [taskId]: arr.map((m) => {
          if (m.role !== "tool") return m;
          try {
            const d = JSON.parse(m.content) as ToolData;
            if (!d.permission || (m.toolId !== permId && d.permission.request.id !== permId)) return m;
            d.permission = { request: d.permission.request, outcome };
            return { ...m, content: JSON.stringify(d) };
          } catch {
            return m;
          }
        }),
      };
    });

  // Insert-or-replace a message by id. Live events carry their DB message id,
  // so replays after a reconnect (snapshot + tail overlap) stay idempotent.
  const upsertMsg = (taskId: string, m: Msg) =>
    setMsgsByTask((prev) => {
      const arr = prev[taskId] ?? [];
      return arr.some((x) => x.id === m.id)
        ? { ...prev, [taskId]: arr.map((x) => (x.id === m.id ? { ...x, ...m } : x)) }
        : { ...prev, [taskId]: [...arr, m] };
    });

  // Drop a message by id — used when a queued follow-up is dequeued (about to
  // run, or cancelled). If it's about to run, the matching `user` event re-adds
  // it as a committed message.
  const removeMsg = (taskId: string, msgId: string) =>
    setMsgsByTask((prev) => ({ ...prev, [taskId]: (prev[taskId] ?? []).filter((m) => m.id !== msgId) }));

  // Apply one server event to local state. Used by the per-task EventSource
  // below; the turn itself runs server-side, detached from any connection.
  const handleStreamEvent = (taskId: string, ev: TaskStreamEvent) => {
    if (ev.type === "snapshot") {
      // Authoritative catch-up: the full persisted transcript, then any parked
      // follow-ups as "queued" bubbles (so a reload mid-run re-renders them),
      // plus whether a turn is live right now (true after a reload mid-turn).
      const committed: Msg[] = ev.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, generation: m.generation, ts: m.created_at }));
      const queued: Msg[] = ev.pending.map((p) => ({ id: p.id, role: "queued" as const, content: p.content, generation: p.generation, ts: p.created_at }));
      setMsgsByTask((prev) => ({ ...prev, [taskId]: [...committed, ...queued] }));
      // Rebuild the open-ask set from the persisted transcript so a reload
      // mid-turn (with asks still parked) counts them correctly.
      const open = new Set<string>();
      for (const m of committed) {
        if (m.role !== "tool") continue;
        try {
          const d = JSON.parse(m.content) as ToolData;
          if (d.ask && !d.ask.answers) open.add(d.ask.id);
          if (d.permission && !d.permission.outcome) open.add(d.permission.request.id);
        } catch {}
      }
      openAsksRef.current[taskId] = open;
      setTaskRunning(taskId, ev.running);
      return;
    }
    const gen = ("generation" in ev ? ev.generation : undefined) ?? 1;
    if (ev.type === "user") upsertMsg(taskId, { id: ev.msgId, role: "user", content: ev.content, generation: gen, ts: ev.ts });
    else if (ev.type === "queued") upsertMsg(taskId, { id: ev.msgId, role: "queued", content: ev.content, generation: gen, ts: ev.ts });
    else if (ev.type === "dequeued") removeMsg(taskId, ev.msgId);
    else if (ev.type === "model") setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, resolved_model: ev.model } : x)));
    else if (ev.type === "assistant") upsertMsg(taskId, { id: ev.msgId ?? `a-${Date.now()}-${Math.random()}`, role: "assistant", content: ev.content, generation: gen, ts: ev.ts });
    else if (ev.type === "tool") {
      const data: ToolData = { title: ev.title, detail: ev.detail, peek: ev.peek, diff: ev.diff, file: ev.file };
      upsertMsg(taskId, { id: ev.msgId ?? `t-${Date.now()}-${Math.random()}`, role: "tool", content: JSON.stringify(data), generation: gen, toolId: ev.id });
    } else if (ev.type === "tool_result") {
      // Match by DB message id (works on snapshot-loaded messages too), falling
      // back to the in-memory tool_use id.
      setMsgsByTask((prev) => {
        const arr = prev[taskId] ?? [];
        return {
          ...prev,
          [taskId]: arr.map((m) => {
            if (m.role !== "tool" || (m.id !== ev.msgId && m.toolId !== ev.id)) return m;
            try { const d = JSON.parse(m.content) as ToolData; d.result = ev.content; d.isError = ev.isError; if (ev.peek) d.peek = ev.peek; return { ...m, content: JSON.stringify(d) }; } catch { return m; }
          }),
        };
      });
    } else if (ev.type === "ask") {
      const data: ToolData = { title: "Question for you", ask: { id: ev.id, questions: ev.questions } };
      upsertMsg(taskId, { id: ev.msgId ?? `ask-${ev.id}`, role: "tool", content: JSON.stringify(data), generation: gen, toolId: ev.id });
      (openAsksRef.current[taskId] ??= new Set()).add(ev.id);
      // Parked on a question: flag the row so it jumps to "Needs your input"
      // (and triggers a notification) while the turn is still live. Mirrors the
      // server's updateTask in lib/runner.ts.
      setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, awaiting_input: 1 } : x)));
    } else if (ev.type === "ask_answered") {
      setAnswerOnMsg(taskId, ev.id, ev.answers);
      // Only drop the flag once every parked ask on this task is answered.
      const open = openAsksRef.current[taskId];
      open?.delete(ev.id);
      if (!open || open.size === 0) {
        setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, awaiting_input: 0 } : x)));
      }
    } else if (ev.type === "permission") {
      const data: ToolData = { title: "Permission needed", permission: { request: ev.request } };
      upsertMsg(taskId, { id: ev.msgId ?? `perm-${ev.request.id}`, role: "tool", content: JSON.stringify(data), generation: gen, toolId: ev.request.id });
      (openAsksRef.current[taskId] ??= new Set()).add(ev.request.id);
      setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, awaiting_input: 1 } : x)));
    } else if (ev.type === "permission_decided") {
      setOutcomeOnMsg(taskId, ev.id, ev.outcome);
      const open = openAsksRef.current[taskId];
      open?.delete(ev.id);
      if (!open || open.size === 0) {
        setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, awaiting_input: 0 } : x)));
      }
    } else if (ev.type === "permission_denied") {
      // The CLI refused the call itself — nothing was parked on the user, so
      // awaiting_input and openAsks stay untouched. Mirrors lib/runner.ts: the
      // already-settled card goes ONTO the tool message the call created,
      // falling back to a card of its own when there is none (a subagent's
      // tool_use blocks never reach this stream).
      const outcome: PermissionOutcome = { decision: "deny", auto: true, reason: "blocked", blockedBy: ev.reasonType, note: ev.reason };
      setMsgsByTask((prev) => {
        const arr = prev[taskId] ?? [];
        const target = arr.find((m) => m.role === "tool" && (m.id === ev.msgId || m.toolId === ev.id));
        if (!target) {
          const title = ev.agentId ? `${ev.tool} (in a subagent)` : ev.tool;
          const data: ToolData = { title, permission: { request: { id: ev.id, tool: ev.tool, title, detail: "", expiresAt: 0 }, outcome } };
          const m: Msg = { id: ev.msgId ?? `perm-${ev.id}`, role: "tool", content: JSON.stringify(data), generation: gen, toolId: ev.id, ts: ev.ts };
          return { ...prev, [taskId]: [...arr, m] };
        }
        return {
          ...prev,
          [taskId]: arr.map((m) => {
            if (m !== target) return m;
            try {
              const d = JSON.parse(m.content) as ToolData;
              d.permission = { request: { id: ev.id, tool: ev.tool, title: d.title, detail: d.detail ?? "", diff: d.diff, expiresAt: 0 }, outcome };
              return { ...m, content: JSON.stringify(d) };
            } catch { return m; }
          }),
        };
      });
    } else if (ev.type === "context") {
      // The agent's own report of how full the window is right now — moves
      // mid-turn, one event per model request whose figure changed. Once a
      // task has one of these it is MEASURED, and the usage-derived estimate
      // below stops touching the gauge.
      setTasks((prev) => prev.map((x) => (x.id === taskId
        ? { ...x, context_tokens: ev.tokens, context_pct: contextPct(ev.tokens, x.model, capsFor(agentsRef.current, x.agent)), context_estimated: false }
        : x)));
    } else if (ev.type === "usage") {
      // Live cumulative spend: add this turn's totals to the task's figure.
      const u = ev.usage;
      const turnTokens = u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens;
      const ctxTokens = u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens;
      setTasks((prev) => prev.map((x) => (x.id === taskId
        ? { ...x, cost_usd: (x.cost_usd ?? 0) + u.cost_usd, total_tokens: (x.total_tokens ?? 0) + turnTokens,
            // Cache buckets accumulate alongside the total so the usage chip's
            // fresh-vs-cached split stays right mid-turn, not just after a reload.
            cache_read_tokens: (x.cache_read_tokens ?? 0) + u.cache_read_tokens,
            cache_creation_tokens: (x.cache_creation_tokens ?? 0) + u.cache_creation_tokens,
            // Only an UNMEASURED task (no `context` event this turn or before:
            // Codex, or a pre-measurement row — a measured figure is never 0)
            // derives its gauge from spend — the turn's input side, which
            // over-reads on tool-heavy turns and is labelled an estimate.
            // Mirrors the COALESCE in lib/store.ts.
            ...(x.context_estimated || !(x.context_tokens > 0)
              ? { context_tokens: ctxTokens, context_pct: contextPct(ctxTokens, x.model, capsFor(agentsRef.current, x.agent)), context_estimated: true }
              : {}) }
        : x)));
    } else if (ev.type === "notice") upsertMsg(taskId, { id: ev.msgId ?? `n-${Date.now()}`, role: "system", content: ev.content, generation: gen });
    else if (ev.type === "error") upsertMsg(taskId, { id: ev.msgId ?? `e-${Date.now()}`, role: "system", content: ev.content, generation: gen });
    else if (ev.type === "suggested") { if (selProjRef.current) loadTasks(selProjRef.current, false); }
    else if (ev.type === "turn_end") {
      setTaskRunning(taskId, false);
      // Any still-parked asks died with the turn (Stop rejects them server-side);
      // the refetch below restores the authoritative awaiting_input flag.
      delete openAsksRef.current[taskId];
      void (async () => {
        try { const fresh = await jget<TaskRow>(`/api/tasks/${taskId}`); setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, ...fresh } : x))); } catch {}
        // Refresh the project list so the cross-project "Needs you" counts/badges update.
        try { setProjects(await jget<ProjectRow[]>("/api/projects")); } catch {}
      })();
    }
  };
  // The handler reads lots of component state; keep the EventSource effect's
  // dependency list down to the task id by routing through a ref.
  const handleStreamEventRef = useRef(handleStreamEvent);
  useEffect(() => { handleStreamEventRef.current = handleStreamEvent; });

  // One live stream per selected task: the server replays a snapshot of the
  // persisted transcript, then tails live turn events. Opening a task,
  // reloading mid-turn, and waking from laptop sleep all converge on the same
  // catch-up-then-tail path — EventSource reconnects re-snapshot automatically.
  useEffect(() => {
    if (!selTask) return;
    const id = selTask;
    const es = new EventSource(`/api/tasks/${id}/messages`);
    es.onmessage = (e) => {
      try { handleStreamEventRef.current(id, JSON.parse(e.data) as TaskStreamEvent); } catch {}
    };
    return () => es.close();
  }, [selTask]);

  return { msgsByTask, appendMsg, setAnswerOnMsg, setOutcomeOnMsg };
}
