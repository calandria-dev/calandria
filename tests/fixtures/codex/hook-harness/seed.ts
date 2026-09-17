// Seeds the throwaway state the Codex hook harness runs against
// (docs/CODEX_HOOK_HARNESS.md). Pure filesystem work, no spawning, so the test
// entrypoint stays about the turn.
//
// One harness root holds everything: the private CODEX_HOME, the workspace the
// turn runs in, and the evidence files. The root defaults to
// ~/.calandria/codex-hook-harness and deliberately sits outside the system temp
// directory: a CODEX_HOME under /tmp makes the CLI print "Refusing to create
// helper binaries under temporary dir". It proceeds anyway, but the warning is
// noise in a harness whose whole output is evidence.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the spawned fixtures (MCP stub, model server, hook) live. */
export const HARNESS_FIXTURES = __dirname;

export interface HarnessPaths {
  root: string;
  codexHome: string;
  workspace: string;
  ledger: string;
  hookLog: string;
  requests: string;
  toolSchemas: string;
  plan: string;
  model: string;
  denyMarker: string;
}

/** One step of the loopback model fixture's plan. */
export type HarnessStep =
  | { kind: "tool"; match?: string; name?: string; namespace?: string; arguments?: Record<string, unknown>; call_id?: string }
  | { kind: "raw"; item: Record<string, unknown> }
  | { kind: "text"; text: string };

/** The harness root: CALANDRIA_CODEX_HARNESS_DIR, else ~/.calandria/codex-hook-harness. */
export function harnessRoot(): string {
  return process.env.CALANDRIA_CODEX_HARNESS_DIR || path.join(os.homedir(), ".calandria", "codex-hook-harness");
}

/**
 * Wipe and re-create the harness root, seed a private CODEX_HOME and a git
 * workspace carrying a project-local PreToolUse hook, and return every path the
 * caller needs. `model` names the model the fixture answers as; it never
 * reaches a real catalog, so any string does.
 */
export function seedHarness({ model = "calandria-harness-model", denyMarker = "DENY_ME" } = {}): HarnessPaths {
  const root = harnessRoot();
  fs.rmSync(root, { recursive: true, force: true });

  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  const paths: HarnessPaths = {
    root,
    codexHome,
    workspace,
    ledger: path.join(root, "ledger.jsonl"),
    hookLog: path.join(root, "hook-log.jsonl"),
    requests: path.join(root, "model-requests.jsonl"),
    toolSchemas: path.join(root, "model-tools.json"),
    plan: path.join(root, "plan.json"),
    model,
    denyMarker,
  };
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });

  // A real git repo, because the CLI reports the workspace's commit in every
  // request and Calandria's own worktree handling assumes one.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "harness@calandria.invalid");
  git("config", "user.name", "Calandria hook harness");
  fs.writeFileSync(path.join(workspace, "README.md"), "Calandria Codex hook harness workspace.\n");
  git("add", "-A");
  git("commit", "-qm", "harness workspace");

  // The hooks.json schema, verified against codex-cli 0.153.0: the top level
  // takes `description` or `hooks`, `hooks` maps a PascalCase event name to a
  // list of matcher groups, and each group's `hooks` list holds internally
  // tagged handlers. An event name in any other case (pre_tool_use,
  // preToolUse, pre-tool-use) is dropped silently, with no warning and no
  // error, so a typo here looks exactly like a project that has no hooks.
  const hookCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(HARNESS_FIXTURES, "pre-tool-use-hook.mjs"))}`;
  fs.writeFileSync(
    path.join(workspace, ".codex", "hooks.json"),
    `${JSON.stringify(
      {
        description: "Calandria hook harness gate: records every tool call and denies the marked one.",
        hooks: {
          PreToolUse: [
            {
              hooks: [{ type: "command", command: hookCommand, timeout_sec: 60, status_message: "calandria hook harness gate" }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );

  // The private CODEX_HOME. No auth.json is written, so the CLI has no login to
  // inherit, and the provider override names no env_key, so it never asks for a
  // key either. The MCP stub is mounted here, not through the driver: this is
  // where a user's own MCP servers live, so the harness exercises that
  // inheritance path (CODEX_INHERIT_MCP) too.
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      "# Throwaway Codex state, written by tests/fixtures/codex/hook-harness/seed.ts.",
      "# Every run wipes and rewrites it. Nothing real belongs in here.",
      `model = ${JSON.stringify(model)}`,
      "",
      `[projects.${JSON.stringify(workspace)}]`,
      "# Project-local hooks are inert until this is set: hooks/list returns an",
      "# empty array and the only signal is a configWarning naming the folder.",
      'trust_level = "trusted"',
      "",
      "[mcp_servers.ledger]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(path.join(HARNESS_FIXTURES, "mcp-stub.mjs"))}]`,
      "startup_timeout_sec = 30",
      "tool_timeout_sec = 120",
      "",
      "[mcp_servers.ledger.env]",
      `CALANDRIA_HARNESS_LEDGER = ${JSON.stringify(paths.ledger)}`,
      "",
    ].join("\n"),
  );

  return paths;
}

/** Write the model fixture's plan file. */
export function writePlan(planPath: string, steps: HarnessStep[]): void {
  fs.writeFileSync(planPath, `${JSON.stringify({ steps }, null, 2)}\n`);
}

/** Read a JSONL evidence file, tolerating absence: nothing happened. */
export function readJsonl<T = Record<string, unknown>>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}
