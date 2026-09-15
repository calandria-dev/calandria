// Resolve a Codex permission mode and optional sandbox override.
// Both transports use this SDK-free mapping. Workspace-write includes the git
// paths required to commit from a linked worktree.

import fs from "node:fs";
import path from "node:path";
import { CODEX_APPROVAL_POLICY, CODEX_WRITABLE_ROOTS } from "../../config";
import { isCodexSandboxMode } from "../../codexSandbox";
export type { CodexSandboxMode } from "../../codexSandbox";
import type { CodexSandboxMode } from "../../codexSandbox";

export const CODEX_MODES = ["auto", "default", "acceptEdits", "bypassPermissions", "plan"] as const;
export type CodexMode = (typeof CODEX_MODES)[number];

/** The mode a null / unknown permission_mode resolves to. */
export const DEFAULT_CODEX_MODE: CodexMode = "auto";

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
  opts: { downgraded?: boolean; extraRoots?: string[]; sandbox?: string | null } = {},
): CodexRunPolicy {
  const m = resolveCodexMode(mode);
  const never = neverAskPolicy(!!opts.downgraded);
  const roots = () => dedupe([...gitWritableRoots(cwd), ...configuredWritableRoots(), ...(opts.extraRoots ?? [])]);
  const sandboxFor = (legacy: CodexSandboxMode) => isCodexSandboxMode(opts.sandbox) ? opts.sandbox : legacy;
  const withSandbox = (legacy: CodexSandboxMode, approval: CodexApprovalPolicy | undefined, reviewer: CodexApprovalsReviewer, asks: boolean): CodexRunPolicy => {
    const sandbox = sandboxFor(legacy);
    return {
      mode: m,
      sandbox,
      approval,
      reviewer,
      network: sandbox !== "read-only",
      writableRoots: sandbox === "workspace-write" ? roots() : [],
      asks,
    };
  };
  switch (m) {
    case "auto":
      return withSandbox("workspace-write", "on-request", "auto_review", false);
    case "default":
      return withSandbox("workspace-write", "on-request", "user", true);
    case "acceptEdits":
      return withSandbox("workspace-write", never, "user", never !== "never" && never !== undefined);
    case "bypassPermissions":
      return withSandbox("danger-full-access", never, "user", false);
    case "plan":
      return withSandbox("read-only", never, "user", false);
  }
}

/**
 * The app-server `SandboxPolicy` object for a resolved policy (turn/start's
 * `sandboxPolicy`). `external` says the caller is already confined; see
 * CODEX_EXTERNAL_SANDBOX in lib/config.ts for which modes may claim that and
 * why read-only may not. Passed in instead of read here so this stays the
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
