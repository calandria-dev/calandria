// What a task's permission mode MEANS to Codex: the sandbox the turn runs in,
// the approval policy that decides who is asked when the model wants out of
// it, and the writable roots the sandbox grants. One resolution shared by the
// app-server transport (which passes a full SandboxPolicy per turn) and the
// exec transport (which can only pass a mode plus `--add-dir`s), so the two
// can't disagree about what a mode does. SDK-free: pure data plus a few
// stat()s, so capabilities.ts and the tests can read it without pulling
// @openai/codex-sdk in.
//
// The five keys are the cross-agent vocabulary tasks, runbooks, schedules and
// app defaults persist (tasks.permission_mode), each mapped to the nearest
// Codex analog rather than to a Claude-shaped meaning:
//
//   auto               workspace-write, approvals on request, Codex's own
//                      reviewer decides them (approvals_reviewer=auto_review):
//                      the "approve for me" the Claude picker's auto is.
//   default            workspace-write, approvals on request, YOU decide: the
//                      model asks to leave the sandbox (a network fetch, a path
//                      outside the worktree, a command the sandbox refused) and
//                      the request parks on a permission card.
//   acceptEdits        workspace-write, never asks: what the sandbox refuses
//                      simply fails and the model works around it. This is what
//                      the old "workspace-write" picker entry was.
//   bypassPermissions  danger-full-access, never asks: no sandbox at all,
//                      Codex's --dangerously-bypass-approvals-and-sandbox.
//   plan               read-only sandbox, never asks: propose without editing.
//
// The writable roots are the part the picker never showed and the user ran
// into first: workspace-write makes the cwd writable but marks its `.git`
// read-only — and for a WORKTREE, whose `.git` is a pointer file, the CLI
// resolves the pointer and protects the real gitdir too (codex-rs
// protocol/src/permissions.rs, default_read_only_subpaths_for_writable_root),
// while the repo's common `.git` sits outside every root anyway. So `git add`
// and `git commit` fail inside a Calandria worktree under every sandboxed
// mode, which for a task whose whole job is to commit is not a sandbox but a
// wall. gitWritableRoots() grants exactly what a commit writes — the task's
// private gitdir (index, HEAD, its reflog) and the common dir's objects, refs
// and logs — and not the common dir itself, so hooks/, config and info/ keep
// Codex's protection: a writable config would let a sandboxed turn plant a
// core.fsmonitor or hooksPath that the user's next `git status` in their real
// checkout runs unsandboxed.

import fs from "node:fs";
import path from "node:path";
import { CODEX_APPROVAL_POLICY, CODEX_WRITABLE_ROOTS } from "../../config";

export const CODEX_MODES = ["auto", "default", "acceptEdits", "bypassPermissions", "plan"] as const;
export type CodexMode = (typeof CODEX_MODES)[number];

/** The mode a null / unknown permission_mode resolves to. */
export const DEFAULT_CODEX_MODE: CodexMode = "auto";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type CodexApprovalsReviewer = "user" | "auto_review";

export interface CodexRunPolicy {
  mode: CodexMode;
  sandbox: CodexSandboxMode;
  /** Undefined = send no override (CODEX_APPROVAL_POLICY=inherit on a never-asking mode). */
  approval: CodexApprovalPolicy | undefined;
  reviewer: CodexApprovalsReviewer;
  /** Whether workspace-write may reach the network. */
  network: boolean;
  /** Extra writable roots beyond the cwd (absolute). Empty unless workspace-write. */
  writableRoots: string[];
  /** Whether a turn under this mode can park on a permission card at all. */
  asks: boolean;
}

/** Resolve a persisted permission_mode to one of the five Codex keys. */
export function resolveCodexMode(mode: string | null | undefined): CodexMode {
  return (CODEX_MODES as readonly string[]).includes(mode ?? "") ? (mode as CodexMode) : DEFAULT_CODEX_MODE;
}

/**
 * The approval policy for the modes that never ask. Normally "never"; an
 * enterprise-managed deployment that disallows it gets "on-request" once the
 * driver has seen the CLI's downgrade warning (lib/agents/codex/driver.ts
 * approvalOverride); "inherit" sends nothing and lets ~/.codex/config.toml
 * decide. `downgraded` is that flag, passed in so this stays store-free.
 */
export function neverAskPolicy(downgraded: boolean): CodexApprovalPolicy | undefined {
  if (CODEX_APPROVAL_POLICY === "inherit") return undefined;
  if (downgraded) return "on-request";
  return CODEX_APPROVAL_POLICY as CodexApprovalPolicy;
}

/**
 * The full run policy for a mode in a working directory. `cwd` is what the
 * git roots are discovered from; pass the worktree the turn runs in.
 */
export function codexRunPolicy(
  mode: string | null | undefined,
  cwd: string,
  opts: { downgraded?: boolean; extraRoots?: string[] } = {},
): CodexRunPolicy {
  const m = resolveCodexMode(mode);
  const never = neverAskPolicy(!!opts.downgraded);
  const roots = () => dedupe([...gitWritableRoots(cwd), ...configuredWritableRoots(), ...(opts.extraRoots ?? [])]);
  switch (m) {
    case "auto":
      return { mode: m, sandbox: "workspace-write", approval: "on-request", reviewer: "auto_review", network: true, writableRoots: roots(), asks: false };
    case "default":
      return { mode: m, sandbox: "workspace-write", approval: "on-request", reviewer: "user", network: true, writableRoots: roots(), asks: true };
    case "acceptEdits":
      return { mode: m, sandbox: "workspace-write", approval: never, reviewer: "user", network: true, writableRoots: roots(), asks: never !== "never" && never !== undefined };
    case "bypassPermissions":
      return { mode: m, sandbox: "danger-full-access", approval: never, reviewer: "user", network: true, writableRoots: [], asks: false };
    case "plan":
      return { mode: m, sandbox: "read-only", approval: never, reviewer: "user", network: false, writableRoots: [], asks: false };
  }
}

/**
 * The app-server `SandboxPolicy` object for a resolved policy (turn/start's
 * `sandboxPolicy`). `external` says the caller is already confined — see
 * CODEX_EXTERNAL_SANDBOX in lib/config.ts for which modes may claim that and
 * why read-only may not. Passed in rather than read here so this stays the
 * pure mapping the tests can drive both ways.
 */
export function sandboxPolicyObject(p: CodexRunPolicy, external = false):
  | { type: "dangerFullAccess" }
  | { type: "externalSandbox" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean } {
  switch (p.sandbox) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "read-only":
      return { type: "readOnly", networkAccess: p.network };
    case "workspace-write":
      return external
        ? { type: "externalSandbox" }
        : { type: "workspaceWrite", writableRoots: p.writableRoots, networkAccess: p.network, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
}

// ---------- writable roots ----------

/**
 * The git paths a commit from `cwd` writes, when `cwd` is a linked worktree:
 * its private gitdir and the common dir's objects/, refs/ and logs/. Empty for
 * a primary checkout (its `.git` is a directory the sandbox protects on
 * purpose, and Calandria never runs a task there anyway) and for a non-git
 * directory. Only paths that exist are returned: the Linux sandbox builds a
 * Landlock rule per root and a rule on a missing path fails the whole policy.
 */
export function gitWritableRoots(cwd: string): string[] {
  const dotGit = path.join(cwd, ".git");
  let pointer: string;
  try {
    if (!fs.statSync(dotGit).isFile()) return [];
    pointer = fs.readFileSync(dotGit, "utf8");
  } catch {
    return [];
  }
  const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!m) return [];
  const gitdir = path.resolve(cwd, m[1]);
  let common = gitdir;
  try {
    const rel = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
    if (rel) common = path.resolve(gitdir, rel);
  } catch {
    /* no commondir file: the gitdir is its own common dir */
  }
  const roots = [gitdir];
  if (common !== gitdir) roots.push(...["objects", "refs", "logs"].map((d) => path.join(common, d)));
  return roots.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/** CODEX_WRITABLE_ROOTS, split on the platform path delimiter, absolute entries only. */
export function configuredWritableRoots(raw: string = CODEX_WRITABLE_ROOTS): string[] {
  return raw
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter((s) => s && path.isAbsolute(s));
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
