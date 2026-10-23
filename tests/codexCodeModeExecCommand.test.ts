import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// This command intentionally runs the host shell; keep the measurement opt-in.
// Re-run with CALANDRIA_CODEX_HOOK_HARNESS=1. The measured hook sees Bash with
// { command }, and nested calls use exec-<uuid> tool_use_ids.
const ON = process.env.CALANDRIA_CODEX_HOOK_HARNESS === "1";

vi.hoisted(() => {
  if (process.env.CALANDRIA_CODEX_HOOK_HARNESS === "1") process.env.CODEX_TRANSPORT = "app-server";
});

import { seedHarness, harnessRoot, readJsonl, type HarnessStep } from "./fixtures/codex/hook-harness/seed";
import { runHarnessTurn } from "./fixtures/codex/hook-harness/run";

const COMMAND_ARGS = [
  { cmd: "printf '%s\\n' 'codex-code-mode-exec-1' > 'nested-exec-command-1.marker'", yield_time_ms: 1000, max_output_tokens: 1000 },
  { cmd: "printf '%s\\n' 'codex-code-mode-exec-2' > 'nested-exec-command-2.marker'", yield_time_ms: 1000, max_output_tokens: 1000 },
] as const;

interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  permission_mode?: string;
}

interface CaseEvidence {
  name: string;
  script: string;
  hookState: { suppressedReason?: string; trustStatus?: string; enabled?: boolean; count: number };
  hooks: HookPayload[];
  markers: { file: string; exists: boolean; content: string | null }[];
  notices: string[];
  toolEvents: { id: string; name?: string }[];
  execOutput: string[];
}

const cases: Record<string, CaseEvidence> = {};

function sequentialScript(): string {
  return [
    `const results = [];`,
    `for (const args of ${JSON.stringify(COMMAND_ARGS)}) {`,
    `  try { results.push({ status: "fulfilled", value: await tools.exec_command(args) }); }`,
    `  catch (error) { results.push({ status: "rejected", reason: String(error) }); }`,
    `}`,
    `text(JSON.stringify(results));`,
  ].join("\n");
}

function concurrentScript(): string {
  return [
    `const results = await Promise.allSettled(${JSON.stringify(COMMAND_ARGS)}.map((args) => tools.exec_command(args)));`,
    `text(JSON.stringify(results.map((result) => result.status === "fulfilled"`,
    `  ? { status: result.status, value: result.value }`,
    `  : { status: result.status, reason: String(result.reason) })));`,
  ].join("\n");
}

async function runCase(
  name: string,
  script: string,
  deny: boolean,
): Promise<CaseEvidence> {
  const p = seedHarness({
    root: path.join(harnessRoot(), "exec-command-matrix", name),
    denyMarker: deny ? "codex-code-mode-exec-" : "UNMATCHABLE_EXEC_DENY_MARKER",
    features: { code_mode: true },
    trustProject: true,
  });
  const steps: HarnessStep[] = [
    { kind: "raw", item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_exec", name: "exec", input: script, status: "completed" } },
    { kind: "text", text: "done." },
  ];
  const { events, inventory } = await runHarnessTurn(p, steps, "Use exec_command from code mode as instructed.", { review: "trust" });
  const listedHooks = (inventory.inventory?.scopes ?? []).flatMap((scope) => scope.hooks);
  const requests = readJsonl<{ input?: { type?: string; output?: { text?: string }[] }[] }>(p.requests);
  const markers = [1, 2].map((n) => {
    const file = path.join(p.workspace, `nested-exec-command-${n}.marker`);
    const exists = fs.existsSync(file);
    return { file, exists, content: exists ? fs.readFileSync(file, "utf8") : null };
  });
  const evidence: CaseEvidence = {
    name,
    script,
    hookState: {
      suppressedReason: inventory.inventory?.suppressedReason,
      trustStatus: listedHooks[0]?.trustStatus,
      enabled: listedHooks[0]?.enabled,
      count: listedHooks.length,
    },
    hooks: readJsonl<{ parsed?: HookPayload }>(p.hookLog).map((entry) => entry.parsed ?? {}),
    markers,
    notices: events.filter((event) => event.type === "notice").map((event) => (event as unknown as { content: string }).content),
    toolEvents: events.filter((event) => event.type === "tool").map((event) => event as unknown as { id: string; name: string }).map(({ id, name: toolName }) => ({ id, name: toolName })),
    execOutput: requests
      .flatMap((request) => request.input ?? [])
      .filter((item) => item.type === "custom_tool_call_output")
      .flatMap((item) => (item.output ?? []).map((output) => output.text ?? "")),
  };
  fs.writeFileSync(path.join(p.root, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  cases[name] = evidence;
  return evidence;
}

describe.skipIf(!ON)("codex code-mode exec_command interception", () => {
  beforeAll(async () => {
    const scripts = { sequential: sequentialScript(), concurrent: concurrentScript() };
    await runCase("sequential-allow", scripts.sequential, false);
    await runCase("sequential-deny", scripts.sequential, true);
    await runCase("concurrent-allow", scripts.concurrent, false);
    await runCase("concurrent-deny", scripts.concurrent, true);
    fs.writeFileSync(path.join(harnessRoot(), "exec-command-matrix", "matrix.json"), `${JSON.stringify(cases, null, 2)}\n`);
  }, 360_000);

  for (const mode of ["sequential", "concurrent"]) {
    it(`${mode}: allow and deny run the identical script`, () => {
      expect(cases[`${mode}-allow`].script).toBe(cases[`${mode}-deny`].script);
    });

    it(`${mode}-allow: Bash hook allows both commands`, () => {
      const c = cases[`${mode}-allow`];
      expect(c.hookState).toMatchObject({ trustStatus: "trusted", enabled: true, count: 1 });
      expect(c.hooks).toHaveLength(2);
      expect(c.hooks.map((h) => h.hook_event_name)).toEqual(["PreToolUse", "PreToolUse"]);
      expect(c.hooks.map((h) => h.permission_mode)).toEqual(["bypassPermissions", "bypassPermissions"]);
      expect(c.hooks.map((h) => h.tool_name)).toEqual(["Bash", "Bash"]);
      expect(c.hooks.map((h) => JSON.stringify(h.tool_input)).sort()).toEqual(
        COMMAND_ARGS.map(({ cmd }) => JSON.stringify({ command: cmd })).sort(),
      );
      const ids = c.hooks.map((h) => h.tool_use_id ?? "");
      for (const id of ids) expect(id).toMatch(/^exec-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(new Set(ids).size).toBe(2);
      expect(c.markers.map(({ exists, content }) => ({ exists, content }))).toEqual([
        { exists: true, content: "codex-code-mode-exec-1\n" },
        { exists: true, content: "codex-code-mode-exec-2\n" },
      ]);
      expect(c.notices.filter((notice) => /^Codex hook preToolUse started/.test(notice))).toHaveLength(2);
      expect(c.notices.filter((notice) => /^Codex hook preToolUse passed/.test(notice))).toHaveLength(2);
      expect(c.notices.filter((notice) => /^Codex hook preToolUse blocked the call/.test(notice))).toHaveLength(0);
      expect(c.notices.filter((notice) => /^Codex hook preToolUse failed/.test(notice))).toHaveLength(0);
      expect(c.toolEvents.map(({ id }) => id).sort()).toEqual(ids.sort());
      const result = JSON.parse(c.execOutput.at(-1) ?? "[]") as { status: string; value?: { exit_code?: number } }[];
      expect(result).toHaveLength(2);
      expect(result.map(({ status, value }) => [status, value?.exit_code])).toEqual([
        ["fulfilled", 0],
        ["fulfilled", 0],
      ]);
    });

    it(`${mode}-deny: Bash hook blocks both commands`, () => {
      const c = cases[`${mode}-deny`];
      expect(c.hookState).toMatchObject({ trustStatus: "trusted", enabled: true, count: 1 });
      expect(c.hooks).toHaveLength(2);
      expect(c.hooks.map((h) => h.hook_event_name)).toEqual(["PreToolUse", "PreToolUse"]);
      expect(c.hooks.map((h) => h.permission_mode)).toEqual(["bypassPermissions", "bypassPermissions"]);
      expect(c.hooks.map((h) => h.tool_name)).toEqual(["Bash", "Bash"]);
      expect(c.hooks.map((h) => JSON.stringify(h.tool_input)).sort()).toEqual(
        COMMAND_ARGS.map(({ cmd }) => JSON.stringify({ command: cmd })).sort(),
      );
      const ids = c.hooks.map((h) => h.tool_use_id ?? "");
      for (const id of ids) expect(id).toMatch(/^exec-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(new Set(ids).size).toBe(2);
      expect(c.markers.map(({ exists, content }) => ({ exists, content }))).toEqual([
        { exists: false, content: null },
        { exists: false, content: null },
      ]);
      expect(c.notices.filter((notice) => /^Codex hook preToolUse started/.test(notice))).toHaveLength(2);
      expect(c.notices.filter((notice) => /^Codex hook preToolUse passed/.test(notice))).toHaveLength(0);
      expect(c.notices.filter((notice) => /^Codex hook preToolUse blocked the call/.test(notice))).toHaveLength(2);
      expect(c.notices.filter((notice) => /^Codex hook preToolUse failed/.test(notice))).toHaveLength(0);
      expect(c.toolEvents).toEqual([]);
      const result = JSON.parse(c.execOutput.at(-1) ?? "[]") as { status: string; reason?: string }[];
      expect(result).toHaveLength(2);
      expect(result.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
      for (const [index, entry] of result.entries()) {
        expect(entry.reason).toContain("Command blocked by PreToolUse hook:");
        expect(entry.reason).toContain(COMMAND_ARGS[index].cmd);
      }
    });
  }
});
