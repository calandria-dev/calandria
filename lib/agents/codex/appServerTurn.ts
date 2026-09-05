// One Codex turn over `codex app-server`: spawn, handshake, start or resume
// the thread, start the turn, stream its notifications into StreamEvents, and
// answer the server's requests — which is the whole reason this transport
// exists. Under `codex exec` (./driver.ts's other transport) an approval
// request is auto-rejected inside the CLI before the host ever sees it; here
// it arrives as a JSON-RPC request the turn cannot finish without our answer,
// and the answer comes from the same permission card and /answer route the
// Claude driver's canUseTool gate parks on (./permissionPrompt.ts).
//
// The process lives exactly one turn, like the exec transport's: a thread is
// persisted by the CLI under ~/.codex, so `thread/resume` on the next turn
// picks up where this one left off, and a process that dies with its turn
// can't leak a parked approval into the next one.

import type { ModelReasoningEffort } from "@openai/codex-sdk";
import type { Project, Task, StreamEvent, AskQuestion, PermissionOutcome } from "../../types";
import { AppServerClient, flattenConfigOverrides, type ConfigObject } from "./appServerClient";
import { mapNotification, newAppServerTurnState, diffLinesOf, unwrapShellCommand, type V2Item } from "./appServerEvents";
import { mapThreadEvent, type CodexMapState } from "./events";
import { makeQueue } from "../shared";
import { describePermission } from "../../permissions";
import { promptPermission, type PromptDecision } from "./permissionPrompt";
import { sandboxPolicyObject, type CodexRunPolicy } from "./policy";
import { interactionDenied, recordUnattendedDenial, UNATTENDED_ASK_DENIAL, UNATTENDED_ASK_NOTE } from "../../runContext";
import { waitForAnswer, ASK_INTERRUPTED_NOTE } from "../../asks";

export interface AppServerTurnArgs {
  task: Task;
  project: Project;
  cwd: string;
  env: Record<string, string>;
  /** Nested config overrides (mcp_servers, model_providers, …), flattened to `-c` flags. */
  config: ConfigObject;
  /** The thread to resume, or null for a fresh one. */
  threadId: string | null;
  /** The user message, given whether the thread is fresh (context seeded) or resumed. */
  prompt: (fresh: boolean) => string;
  /** The model override to request, or null to let the CLI pick. */
  model: string | null;
  effort?: ModelReasoningEffort;
  policy: CodexRunPolicy;
  /** The usage baseline and emitted-tool set (./events.ts). Mutated in place. */
  state: CodexMapState;
  abort?: AbortController;
  /** Warning text to run the approval-downgrade classifier over. */
  onWarning?: (text: string) => void;
  /** Override the binary (tests). */
  bin?: string;
}

/** How long a control request (handshake, thread/start, turn/start) may take before the turn is declared wedged. */
const CONTROL_TIMEOUT_MS = 60_000;
/** How long after turn/interrupt to wait for the CLI to say "interrupted" before killing it. */
const INTERRUPT_GRACE_MS = 3_000;

type Approval = "accept" | "acceptForSession" | "decline" | "cancel";

export async function* runAppServerTurn(args: AppServerTurnArgs): AsyncGenerator<StreamEvent> {
  const { task, project, policy, state, abort } = args;
  const queue = makeQueue<StreamEvent>();
  const tstate = newAppServerTurnState();
  // The latest shape of every item this turn, keyed by id: an approval
  // request names the item, not its content, so the card is built from here.
  const items = new Map<string, V2Item>();
  // Notifications that arrive before turn/start has answered with our turn id
  // (the CLI may push turn/started ahead of the response) are replayed once we
  // know it, so the first item is never dropped.
  let early: { method: string; params: unknown }[] | null = [];
  let ended = false;
  let threadId: string | null = null;
  let turnId: string | null = null;

  const push = (ev: StreamEvent) => queue.push(ev);

  const handleNotification = (method: string, params: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if ((method === "item/started" || method === "item/completed") && p.item) {
      const it = p.item as V2Item;
      items.set(it.id, it);
    }
    const mapped = mapNotification(method, params, tstate);
    for (const ev of mapped.events) for (const out of mapThreadEvent(ev, state)) push(out);
    if (mapped.contextTokens != null) push({ type: "context", tokens: mapped.contextTokens });
    if (mapped.notice) push({ type: "notice", content: mapped.notice });
    if (mapped.warning) args.onWarning?.(mapped.warning);
    if (mapped.turnEnded) {
      ended = true;
      queue.close();
    }
  };

  const client = new AppServerClient({
    onNotification: (method, params) => {
      if (early) early.push({ method, params });
      else handleNotification(method, params);
    },
    onRequest: (method, params) => handleRequest(method, params),
    onExit: ({ stderrTail }) => {
      if (ended) return;
      ended = true;
      if (!abort?.signal.aborted) push({ type: "error", content: stderrTail ? `codex app-server exited: ${stderrTail}` : "codex app-server exited before the turn finished" });
      queue.close();
    },
  });

  // ---------- server requests ----------

  const promptCtx = { taskId: task.id, projectId: project.id, push, signal: abort?.signal };

  const toApproval = (d: PromptDecision): Approval => {
    if (d.kind === "allow") return d.always ? "acceptForSession" : "accept";
    return d.interrupted ? "cancel" : "decline";
  };

  async function handleRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const itemId = String(p.itemId ?? "");
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const approvalId = p.approvalId ? `:${String(p.approvalId)}` : "";
        const id = `perm:${itemId || `cmd-${Date.now()}`}${approvalId}`;
        const net = p.networkApprovalContext as { host?: string; protocol?: string } | null | undefined;
        const item = items.get(itemId) as Extract<V2Item, { type: "commandExecution" }> | undefined;
        // Rules and the card both see the command without the CLI's shell
        // wrapper, so "Always allow `git commit …`" means what it says.
        const command = unwrapShellCommand(String(p.command ?? item?.command ?? ""));
        const reason = typeof p.reason === "string" && p.reason.trim() ? p.reason.trim() : undefined;
        if (net?.host) {
          // A network grant, not a command: no durable rule fits, so "always"
          // is the CLI's own per-session memory (or its proposed policy
          // amendment, when it offers one).
          const d = await promptPermission(promptCtx, {
            id,
            tool: "Network",
            input: { command, host: net.host },
            title: `Allow network access to ${net.host}`,
            detail: command || `${net.protocol ?? "network"} to ${net.host}`,
            description: reason,
            scope: { scope: "session", value: net.host, label: `Allow ${net.host} for this session` },
          });
          const amend = (p.proposedNetworkPolicyAmendments as unknown[] | null | undefined)?.[0];
          if (d.kind === "allow" && d.always && amend) return { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: amend } } };
          return { decision: toApproval(d) };
        }
        const described = describePermission("Bash", { command });
        const d = await promptPermission(promptCtx, {
          id,
          tool: "Bash",
          input: { command },
          title: described.title,
          detail: described.detail,
          description: reason ?? (p.kind === "writeStdin" ? "Wants to write to the running command's stdin" : undefined),
          diff: described.diff,
        });
        return { decision: toApproval(d) };
      }
      case "item/fileChange/requestApproval": {
        const item = items.get(itemId) as Extract<V2Item, { type: "fileChange" }> | undefined;
        const changes = item?.changes ?? [];
        const verb = { add: "Create", update: "Edit", delete: "Delete" } as const;
        const title =
          changes.length === 1
            ? `${verb[changes[0].kind] ?? "Change"} ${basename(changes[0].path)}`
            : `Apply changes to ${changes.length || "some"} files`;
        const grantRoot = typeof p.grantRoot === "string" ? p.grantRoot : undefined;
        const reason = typeof p.reason === "string" && p.reason.trim() ? p.reason.trim() : undefined;
        const d = await promptPermission(promptCtx, {
          id: `perm:${itemId || `patch-${Date.now()}`}`,
          tool: "Edit",
          input: { file_path: changes[0]?.path ?? "" },
          title,
          detail: changes.map((c) => `${c.kind}  ${c.path}`).join("\n") || "(no paths reported)",
          description: grantRoot ? `Writes outside the sandbox, under ${grantRoot}` : reason,
          diff: diffLinesOf(changes.map((c) => c.diff ?? "").join("\n")),
          scope: { scope: "session", value: "fileChange", label: "Don't ask again this session" },
        });
        return { decision: toApproval(d) };
      }
      case "item/permissions/requestApproval": {
        const perms = (p.permissions ?? {}) as {
          network?: { enabled?: boolean | null } | null;
          fileSystem?: { read?: string[] | null; write?: string[] | null; entries?: unknown[] } | null;
        };
        const lines: string[] = [];
        if (perms.network) lines.push("Network access");
        if (perms.fileSystem?.write?.length) lines.push(`Write: ${perms.fileSystem.write.join(", ")}`);
        if (perms.fileSystem?.read?.length) lines.push(`Read: ${perms.fileSystem.read.join(", ")}`);
        const reason = typeof p.reason === "string" && p.reason.trim() ? p.reason.trim() : undefined;
        const d = await promptPermission(promptCtx, {
          id: `perm:${itemId || `grant-${Date.now()}`}`,
          tool: "Permissions",
          input: { permissions: perms },
          title: "Codex asks for more access",
          detail: lines.join("\n") || "(unspecified)",
          description: reason,
          scope: { scope: "session", value: "permissions", label: "Grant for the rest of this session" },
        });
        if (d.kind !== "allow") return { permissions: {}, scope: "turn" };
        const granted: Record<string, unknown> = {};
        if (perms.network) granted.network = { enabled: perms.network.enabled ?? true };
        if (perms.fileSystem) granted.fileSystem = perms.fileSystem;
        return { permissions: granted, scope: d.always ? "session" : "turn" };
      }
      case "item/tool/requestUserInput":
        return askUser(itemId, p);
      case "mcpServer/elicitation/request":
        // No form UI for an MCP server's own elicitation; decline cleanly.
        return { action: "decline", content: null, _meta: null };
      default:
        throw new Error(`Calandria does not handle ${method}`);
    }
  }

  // Codex's native question tool, rendered as the same ask card the MCP
  // bridge's ask_user uses. A declared-unattended run (a schedule) settles it
  // as a decided permission card instead, exactly as the Claude driver does.
  async function askUser(itemId: string, p: Record<string, unknown>): Promise<unknown> {
    const raw = (p.questions as { id: string; header?: string; question: string; options?: { label: string; description?: string }[] | null }[] | undefined) ?? [];
    const id = `ask:${itemId || Date.now()}`;
    if (interactionDenied(task.id)) {
      recordUnattendedDenial(task.id);
      const outcome: PermissionOutcome = { decision: "deny", auto: true, reason: "unattended", note: UNATTENDED_ASK_NOTE };
      push({
        type: "permission",
        request: { id, tool: "request_user_input", title: "Question for you", detail: raw.map((q) => q.question).join("\n"), expiresAt: Date.now() },
      });
      push({ type: "permission_decided", id, outcome });
      throw new Error(UNATTENDED_ASK_DENIAL);
    }
    const questions: AskQuestion[] = raw.map((q) => ({
      question: q.question,
      header: (q.header || "Question").slice(0, 12),
      multiSelect: false,
      options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
    }));
    push({ type: "ask", id, questions });
    try {
      const answers = await waitForAnswer(task.id, id, questions, abort?.signal);
      push({ type: "ask_answered", id, answers });
      const out: Record<string, { answers: string[] }> = {};
      raw.forEach((q, i) => {
        out[q.id] = { answers: answers[i] ?? [] };
      });
      return { answers: out };
    } catch (e) {
      push({ type: "ask_dismissed", id, dismissal: { reason: "interrupted", note: ASK_INTERRUPTED_NOTE } });
      throw e;
    }
  }

  // ---------- the turn ----------

  const withTimeout = <T>(p: Promise<T>, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`codex app-server did not answer ${what} within ${CONTROL_TIMEOUT_MS / 1000}s`)), CONTROL_TIMEOUT_MS);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });

  const onAbort = () => {
    if (ended) return;
    if (threadId && turnId) {
      void client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      setTimeout(() => {
        if (!ended) {
          ended = true;
          queue.close();
        }
        client.close();
      }, INTERRUPT_GRACE_MS).unref?.();
    } else {
      ended = true;
      queue.close();
      client.close();
    }
  };

  try {
    if (abort?.signal.aborted) return;
    abort?.signal.addEventListener("abort", onAbort, { once: true });

    await withTimeout(
      client.start({ cwd: args.cwd, env: args.env, configOverrides: flattenConfigOverrides(args.config), bin: args.bin }),
      "the handshake",
    );

    const threadOpts = {
      cwd: args.cwd,
      sandbox: policy.sandbox,
      ...(policy.approval ? { approvalPolicy: policy.approval } : {}),
      approvalsReviewer: policy.reviewer,
      ...(args.model ? { model: args.model } : {}),
    };
    let fresh = !args.threadId;
    let started: { thread?: { id?: string } } | null = null;
    if (args.threadId) {
      try {
        started = await withTimeout(client.request("thread/resume", { threadId: args.threadId, ...threadOpts }), "thread/resume");
      } catch (e) {
        // The CLI no longer has the thread (a pruned ~/.codex, a different
        // machine). Say so and continue on a fresh one, seeded with context.
        push({ type: "notice", content: `Codex could not resume its previous thread (${messageOf(e)}); starting a fresh one.` });
        fresh = true;
      }
    }
    if (!started) started = await withTimeout(client.request("thread/start", threadOpts), "thread/start");
    threadId = started?.thread?.id ?? null;
    if (!threadId) throw new Error("codex app-server started a thread without an id");
    push({ type: "session", sessionId: threadId });

    const turn = await withTimeout(
      client.request<{ turn?: { id?: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text: args.prompt(fresh), text_elements: [] }],
        cwd: args.cwd,
        sandboxPolicy: sandboxPolicyObject(policy),
        ...(policy.approval ? { approvalPolicy: policy.approval } : {}),
        approvalsReviewer: policy.reviewer,
        ...(args.model ? { model: args.model } : {}),
        ...(args.effort ? { effort: args.effort } : {}),
      }),
      "turn/start",
    );
    turnId = turn?.turn?.id ?? null;
    if (!turnId) throw new Error("codex app-server started a turn without an id");
    tstate.turnId = turnId;
    const replay = early ?? [];
    early = null;
    for (const n of replay) handleNotification(n.method, n.params);

    for await (const ev of queue.drain()) yield ev;
  } catch (err) {
    if (!abort?.signal.aborted) push({ type: "error", content: messageOf(err) });
    ended = true;
    queue.close();
    for await (const ev of queue.drain()) yield ev;
  } finally {
    abort?.signal.removeEventListener("abort", onAbort);
    client.close();
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? p;
