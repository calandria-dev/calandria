import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Nested code-mode MCP interception, measured (docs/CODEX_HOOK_HARNESS.md):
//
//   CALANDRIA_CODEX_HOOK_HARNESS=1 npx vitest run tests/codexCodeModeMatrix.test.ts
//
// Codex's `code_mode` feature adds a custom tool named `exec` that runs
// JavaScript in a V8 isolate and hangs every other tool off a global `tools`
// object. A call made from inside that script is a NESTED call: the model never
// emits a function_call item for it, so whether a PreToolUse hook sees it, and
// whether denying it stops the operation, cannot be read off the wire.
//
// This file runs the same allow/deny pair down three call paths (direct,
// sequential nested, concurrent nested) and records the hook payload, the hook
// run notices, and the MCP stub's ledger for each. The ledger is the evidence
// an operation actually happened; an empty ledger alone proves nothing, so
// every deny case is paired with an allow case over the identical script.
//
// Off by default, like the harness it builds on.

const ON = process.env.CALANDRIA_CODEX_HOOK_HARNESS === "1";

vi.hoisted(() => {
  // Before the driver is imported: hook run notifications only exist on the
  // app-server transport.
  if (process.env.CALANDRIA_CODEX_HOOK_HARNESS === "1") process.env.CODEX_TRANSPORT = "app-server";
});

import { seedHarness, harnessRoot, readJsonl, type HarnessPaths, type HarnessStep } from "./fixtures/codex/hook-harness/seed";
import { runHarnessTurn, type HarnessTurnOptions } from "./fixtures/codex/hook-harness/run";

const DENY = "DENY_ME";

/** One hook invocation, as the CLI sent it on stdin. */
interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  permission_mode?: string;
}

/** Everything one case measured. Written to matrix.json for the write-up. */
interface CaseEvidence {
  name: string;
  codeMode: boolean;
  hookState: { suppressedReason?: string; trustStatus?: string; enabled?: boolean; count: number };
  hooks: HookPayload[];
  ledger: { tool: string; args: Record<string, unknown> }[];
  notices: string[];
  toolEvents: { id: string; name: string }[];
  execOutput: string[];
}

const cases: Record<string, CaseEvidence> = {};

/** The JS one `exec` call runs. `note` is spliced in so allow and deny differ only there. */
function sequentialScript(a: string, b: string): string {
  return [
    `const r = [];`,
    `for (const note of ${JSON.stringify([a, b])}) {`,
    `  try { r.push("ok:" + JSON.stringify(await tools.mcp__ledger__ledger_note({ note }))); }`,
    `  catch (e) { r.push("threw:" + String(e)); }`,
    `}`,
    `for (const line of r) text(line);`,
  ].join("\n");
}

/** The same two calls started together, so the host dispatches them concurrently. */
function concurrentScript(a: string, b: string): string {
  return [
    `const settled = await Promise.allSettled([`,
    `  tools.mcp__ledger__ledger_note({ note: ${JSON.stringify(a)} }),`,
    `  tools.mcp__ledger__ledger_probe({ label: ${JSON.stringify(b)} }),`,
    `]);`,
    `for (const s of settled) text(s.status + ":" + JSON.stringify(s.value ?? String(s.reason)));`,
  ].join("\n");
}

/** Run one case in its own harness root and record what it measured. */
async function runCase(
  name: string,
  opts: { codeMode: boolean; steps: (p: HarnessPaths) => HarnessStep[]; prompt: string } & HarnessTurnOptions & { trustProject?: boolean },
): Promise<CaseEvidence> {
  const p = seedHarness({
    root: path.join(harnessRoot(), "matrix", name),
    denyMarker: DENY,
    features: opts.codeMode ? { code_mode: true } : {},
    trustProject: opts.trustProject ?? true,
  });
  const { events, inventory } = await runHarnessTurn(p, opts.steps(p), opts.prompt, { review: opts.review, beforeTurn: opts.beforeTurn });
  const listedHooks = (inventory.inventory?.scopes ?? []).flatMap((s) => s.hooks);
  const requests = readJsonl<{ input?: { type?: string; output?: { text?: string }[] }[] }>(p.requests);
  const evidence: CaseEvidence = {
    name,
    codeMode: opts.codeMode,
    hookState: {
      suppressedReason: inventory.inventory?.suppressedReason,
      trustStatus: listedHooks[0]?.trustStatus,
      enabled: listedHooks[0]?.enabled,
      count: listedHooks.length,
    },
    hooks: readJsonl<{ parsed?: HookPayload }>(p.hookLog).map((h) => h.parsed ?? {}),
    ledger: readJsonl<{ tool: string; args: Record<string, unknown> }>(p.ledger),
    notices: events.filter((e) => e.type === "notice").map((e) => (e as unknown as { content: string }).content),
    toolEvents: events.filter((e) => e.type === "tool").map((e) => e as unknown as { id: string; name: string }).map(({ id, name: n }) => ({ id, name: n })),
    execOutput: requests
      .flatMap((r) => r.input ?? [])
      .filter((i) => i.type === "custom_tool_call_output")
      .flatMap((i) => (i.output ?? []).map((o) => o.text ?? "")),
  };
  fs.writeFileSync(path.join(p.root, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  cases[name] = evidence;
  return evidence;
}

/** The hook payloads for calls whose input carries `marker`. */
function hooksFor(c: CaseEvidence, marker: string): HookPayload[] {
  return c.hooks.filter((h) => JSON.stringify(h.tool_input ?? {}).includes(marker));
}

/** The ledger lines whose arguments carry `marker`. */
function ledgerFor(c: CaseEvidence, marker: string) {
  return c.ledger.filter((e) => JSON.stringify(e.args ?? {}).includes(marker));
}

describe.skipIf(!ON)("codex nested code-mode MCP interception", () => {
  beforeAll(async () => {
    // Path 1: the direct call, the shape the blocking task measured. Repeated
    // here so the three paths are compared under one identical hook.
    await runCase("direct-allow", {
      codeMode: false,
      prompt: "Call the ledger tool as instructed.",
      steps: () => [
        { kind: "tool", match: "ledger_note", arguments: { note: "allow-1" } },
        { kind: "tool", match: "ledger_note", arguments: { note: "allow-2" } },
        { kind: "text", text: "done." },
      ],
    });
    await runCase("direct-deny", {
      codeMode: false,
      prompt: "Call the ledger tool as instructed.",
      steps: () => [
        { kind: "tool", match: "ledger_note", arguments: { note: `${DENY} deny-1` } },
        { kind: "tool", match: "ledger_note", arguments: { note: `${DENY} deny-2` } },
        { kind: "text", text: "done." },
      ],
    });

    // Paths 2 and 3: nested calls, reached only from inside the `exec` script.
    // The outer call is a custom_tool_call carrying raw JavaScript, which is
    // why it takes a `raw` step: the fixture models function calls, not this.
    const nested = (input: string): HarnessStep[] => [
      { kind: "raw", item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_exec", name: "exec", input, status: "completed" } },
      { kind: "text", text: "done." },
    ];
    await runCase("nested-sequential-allow", {
      codeMode: true,
      prompt: "Use the exec tool as instructed.",
      steps: () => nested(sequentialScript("allow-1", "allow-2")),
    });
    await runCase("nested-sequential-deny", {
      codeMode: true,
      prompt: "Use the exec tool as instructed.",
      steps: () => nested(sequentialScript(`${DENY} deny-1`, `${DENY} deny-2`)),
    });
    await runCase("nested-concurrent-allow", {
      codeMode: true,
      prompt: "Use the exec tool as instructed.",
      steps: () => nested(concurrentScript("allow-1", "allow-2")),
    });
    await runCase("nested-concurrent-deny", {
      codeMode: true,
      prompt: "Use the exec tool as instructed.",
      steps: () => nested(concurrentScript(`${DENY} deny-1`, `${DENY} deny-2`)),
    });
    // The sharpest correlation test: two calls in flight together, one denied
    // and one not. Nothing but a per-call gate can produce this outcome.
    await runCase("nested-concurrent-mixed", {
      codeMode: true,
      prompt: "Use the exec tool as instructed.",
      steps: () => nested(concurrentScript("allow-1", `${DENY} deny-2`)),
    });

    // The four controls. Each puts the hook into a state where the CLI is
    // expected to skip it, over the identical deny script the nested cases
    // used. A skipped hook means the call is NOT intercepted, so the ledger
    // filling up is the proof the control is a real control and not a case
    // where the call simply never happened.
    const denyScript = () => nested(sequentialScript(`${DENY} deny-1`, `${DENY} deny-2`));
    await runCase("control-untrusted-project", {
      codeMode: true,
      trustProject: false,
      prompt: "Use the exec tool as instructed.",
      steps: denyScript,
    });
    await runCase("control-unreviewed", {
      codeMode: true,
      review: "none",
      prompt: "Use the exec tool as instructed.",
      steps: denyScript,
    });
    await runCase("control-disabled", {
      codeMode: true,
      review: "disable",
      prompt: "Use the exec tool as instructed.",
      steps: denyScript,
    });
    await runCase("control-modified", {
      codeMode: true,
      prompt: "Use the exec tool as instructed.",
      steps: denyScript,
      // Trusted, then edited: the pinned hash no longer matches what is on
      // disk, which is the case a hook that rewrites itself mid-turn produces.
      // The edit has to touch the handler. The file's top-level `description`
      // is outside the hash, so changing it leaves the hook trusted and
      // running (measured, see docs/CODEX_HOOK_HARNESS.md).
      beforeTurn: (p) => {
        const f = path.join(p.workspace, ".codex", "hooks.json");
        const doc = JSON.parse(fs.readFileSync(f, "utf8"));
        doc.hooks.PreToolUse[0].hooks[0].command += " --edited-after-review";
        fs.writeFileSync(f, `${JSON.stringify(doc, null, 2)}\n`);
      },
    });

    fs.writeFileSync(path.join(harnessRoot(), "matrix", "matrix.json"), `${JSON.stringify(cases, null, 2)}\n`);
  }, 900_000);

  for (const name of ["direct-allow", "nested-sequential-allow", "nested-concurrent-allow"]) {
    it(`${name}: the hook sees both calls by their canonical name and both reach the stub`, () => {
      const c = cases[name];
      expect(c.hooks).toHaveLength(2);
      for (const h of c.hooks) {
        expect(h.hook_event_name).toBe("PreToolUse");
        expect(h.tool_name).toMatch(/^mcp__ledger__ledger_(note|probe)$/);
        expect(h.tool_use_id).toBeTruthy();
      }
      // Arguments unchanged: what the hook saw is what the stub recorded.
      expect(c.hooks.map((h) => JSON.stringify(h.tool_input)).sort()).toEqual(c.ledger.map((e) => JSON.stringify(e.args)).sort());
      expect(ledgerFor(c, "allow-1")).toHaveLength(1);
      expect(ledgerFor(c, "allow-2")).toHaveLength(1);
      expect(c.notices.filter((n) => /blocked the call/.test(n))).toEqual([]);
    });
  }

  for (const name of ["direct-deny", "nested-sequential-deny", "nested-concurrent-deny"]) {
    it(`${name}: every denied call has a hook denial and no stub invocation`, () => {
      const c = cases[name];
      expect(c.hooks).toHaveLength(2);
      for (const h of c.hooks) expect(h.tool_name).toMatch(/^mcp__ledger__ledger_(note|probe)$/);
      // The denial is what kept the stub empty. Without the paired notices an
      // empty ledger would equally mean the call never happened.
      expect(c.notices.filter((n) => /blocked the call/.test(n))).toHaveLength(2);
      expect(c.ledger).toEqual([]);
    });
  }

  it("nested-concurrent-mixed: two calls in flight, one denied, one through", () => {
    const c = cases["nested-concurrent-mixed"];
    expect(hooksFor(c, "allow-1")).toHaveLength(1);
    expect(hooksFor(c, DENY)).toHaveLength(1);
    expect(ledgerFor(c, "allow-1")).toHaveLength(1);
    expect(ledgerFor(c, DENY)).toEqual([]);
    expect(c.notices.filter((n) => /blocked the call/.test(n))).toHaveLength(1);
  });

  it("reports a nested denial back into the script as a throw naming the tool", () => {
    const text = cases["nested-sequential-deny"].execOutput.join("\n");
    expect(text).toContain("Tool call blocked by PreToolUse hook");
    expect(text).toContain("mcp__ledger__ledger_note");
  });

  it("gives a nested call an exec-scoped tool_use_id that correlates it to the transcript", () => {
    const c = cases["nested-sequential-allow"];
    for (const h of c.hooks) expect(h.tool_use_id).toMatch(/^exec-/);
    // Calandria surfaces the nested call itself on the transcript under that
    // same id, so a hook payload and a transcript row can be lined up.
    expect(c.toolEvents.map((t) => t.id).sort()).toEqual(c.hooks.map((h) => h.tool_use_id!).sort());
  });

  it("fires no hook for the exec envelope itself, only for what it calls", () => {
    // The outer custom_tool_call carrying the JavaScript never reaches the
    // hook. A matcher written against `exec` would see nothing; interception
    // happens one level down.
    for (const name of ["nested-sequential-allow", "nested-concurrent-allow"]) {
      expect(cases[name].hooks.some((h) => h.tool_name === "exec")).toBe(false);
    }
  });

  it("control-untrusted-project: no inventory, no hook run, the calls go through", () => {
    const c = cases["control-untrusted-project"];
    expect(c.hookState.count).toBe(0);
    expect(c.hookState.suppressedReason ?? "").toMatch(/trust/i);
    expect(c.hooks).toEqual([]);
    expect(c.ledger).toHaveLength(2);
  });

  it("control-unreviewed: the hook is listed untrusted, does not run, and the calls go through", () => {
    const c = cases["control-unreviewed"];
    expect(c.hookState.trustStatus).toBe("untrusted");
    expect(c.hooks).toEqual([]);
    expect(c.ledger).toHaveLength(2);
  });

  it("control-disabled: the hook is listed disabled, does not run, and the calls go through", () => {
    const c = cases["control-disabled"];
    expect(c.hookState.enabled).toBe(false);
    expect(c.hooks).toEqual([]);
    expect(c.ledger).toHaveLength(2);
  });

  it("control-modified: editing a trusted hook drops it back to modified and it does not run", () => {
    const c = cases["control-modified"];
    expect(c.hookState.trustStatus).toBe("modified");
    expect(c.hooks).toEqual([]);
    expect(c.ledger).toHaveLength(2);
  });
});
