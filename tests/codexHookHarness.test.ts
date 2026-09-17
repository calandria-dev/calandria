import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The isolated Codex hook launch harness. Off by default; see
// docs/CODEX_HOOK_HARNESS.md for what it isolates, what it does not, and how to
// read the evidence it leaves behind:
//
//   CALANDRIA_CODEX_HOOK_HARNESS=1 npx vitest run tests/codexHookHarness.test.ts
//
// It drives the real `codex` binary through Calandria's own Codex driver rather
// than through a bare CLI invocation, because the point is to exercise the host
// integration: the provider override, the MCP mount, the hook trust writes and
// the hook run notices on the transcript all come from lib/agents/codex/.
//
// Nothing here reaches a live service or a real account. The model is a
// loopback fixture reached through the ordinary provider override, CODEX_HOME
// is a throwaway directory with no auth.json in it, and the only tools the
// model can call belong to an inert MCP stub.

const ON = process.env.CALANDRIA_CODEX_HOOK_HARNESS === "1";

vi.hoisted(() => {
  // Before the driver is imported: hook run notifications only exist on the
  // app-server transport.
  if (process.env.CALANDRIA_CODEX_HOOK_HARNESS === "1") process.env.CODEX_TRANSPORT = "app-server";
});

import { codexDriver } from "@/lib/agents/codex/driver";
import { createProject, createTask, updateProject } from "@/lib/store";
import { subscribeGlobal } from "@/lib/events";
import type { StreamEvent } from "@/lib/types";
import { seedHarness, writePlan, readJsonl, HARNESS_FIXTURES, type HarnessPaths } from "./fixtures/codex/hook-harness/seed";

describe.skipIf(!ON)("codex hook harness (isolated launch)", () => {
  let p: HarnessPaths;
  let model: ChildProcess | null = null;
  const events: StreamEvent[] = [];

  beforeAll(async () => {
    p = seedHarness();
    // The private state, replacing the suite's scratch CODEX_HOME. The driver
    // reads the turn environment from the server's own, so setting it here is
    // what the spawned CLI inherits.
    process.env.CODEX_HOME = p.codexHome;
    process.env.CALANDRIA_HARNESS_HOOK_LOG = p.hookLog;
    process.env.CALANDRIA_HARNESS_HOOK_DENY = p.denyMarker;
    subscribeGlobal(() => {});

    // Two ledger calls and a closing message. The second carries the deny
    // marker, so the PreToolUse hook refuses it; the CLI then asks the fixture
    // again and gets the closing text.
    writePlan(p.plan, [
      { kind: "tool", match: "ledger_note", arguments: { note: "allowed-call" } },
      { kind: "tool", match: "ledger_note", arguments: { note: `${p.denyMarker} blocked-call` } },
      { kind: "text", text: "harness turn complete." },
    ]);

    const port = await startModelServer();
    // The ordinary provider override path (lib/agents/codex/provider.ts) reads
    // these off the turn environment, which starts from the server's own.
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.CODEX_MODEL = p.model;
    delete process.env.OPENAI_API_KEY;

    // Trust the hook through Calandria's own review path, the call Settings
    // makes. Per-hook trust is separate from project trust: the project is
    // trusted in config.toml, so the hook is visible, and this pins its
    // current hash so the CLI will run it. Doing it this way
    // means the harness never passes --dangerously-bypass-hook-trust, so a turn
    // here is configured exactly like an ordinary one.
    const result = await codexDriver.listHooks!(p.workspace);
    fs.writeFileSync(path.join(p.root, "hook-inventory.json"), `${JSON.stringify(result, null, 2)}\n`);
    expect(result.error).toBeUndefined();
    const hooks = (result.inventory?.scopes ?? []).flatMap((s) => s.hooks);
    expect(hooks.map((h) => h.eventName)).toContain("preToolUse");
    const reviewed = await codexDriver.reviewHooks!(
      p.workspace,
      hooks.map((h) => ({ key: h.key, action: "trust" as const })),
    );
    expect(reviewed.ok).toBe(true);

    const project = createProject({ name: "Codex hook harness", repo_path: p.workspace });
    updateProject(project.id, { default_agent: "codex" });
    // bypassPermissions is the only mode that reaches danger-full-access, and
    // on a host whose AppArmor policy denies bwrap user namespaces it is the
    // only mode under which the CLI can run a command.
    const task = createTask({
      project_id: project.id,
      title: "hook-harness",
      description: "",
      permission_mode: "bypassPermissions",
    });
    for await (const ev of codexDriver.runTurn(task, project, "Call the ledger tool twice as instructed, then stop.")) {
      events.push(ev);
    }
    fs.writeFileSync(path.join(p.root, "transcript.json"), `${JSON.stringify(events, null, 2)}\n`);
  }, 300_000);

  afterAll(() => {
    model?.kill();
  });

  it("runs the turn against the loopback fixture with no live call", () => {
    const requests = readJsonl<{ model?: string }>(p.requests);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0].model).toBe(p.model);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
  });

  it("mounts the MCP stub and advertises its tools to the model", () => {
    const requests = readJsonl<{ tools?: string[] }>(p.requests);
    const advertised = new Set(requests.flatMap((r) => r.tools ?? []));
    expect([...advertised].some((n) => n.includes("ledger"))).toBe(true);
  });

  it("fires the PreToolUse hook on every tool call and reports it on the transcript", () => {
    expect(readJsonl(p.hookLog).length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === "notice" && /hook/i.test(e.content))).toBe(true);
  });

  it("records the allowed call in the ledger with its arguments unchanged", () => {
    const ledger = readJsonl<{ tool: string; args: { note?: string } }>(p.ledger);
    const allowed = ledger.filter((e) => e.args?.note === "allowed-call");
    expect(allowed).toHaveLength(1);
    expect(allowed[0].tool).toBe("ledger_note");
  });

  it("leaves no ledger entry for the call the hook denied", () => {
    const ledger = readJsonl<{ args: { note?: string } }>(p.ledger);
    expect(ledger.filter((e) => (e.args?.note ?? "").includes(p.denyMarker))).toHaveLength(0);
  });

  /** Start the loopback model fixture and resolve the port it bound. */
  function startModelServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HARNESS_FIXTURES, "model-server.mjs")], {
        env: { ...process.env, CALANDRIA_HARNESS_PLAN: p.plan, CALANDRIA_HARNESS_REQUESTS: p.requests, CALANDRIA_HARNESS_TOOL_SCHEMAS: p.toolSchemas },
        stdio: ["ignore", "pipe", "inherit"],
      });
      model = child;
      const timer = setTimeout(() => reject(new Error("model fixture did not report a port")), 10_000);
      child.stdout!.on("data", (c: Buffer) => {
        try {
          const { port } = JSON.parse(c.toString().trim().split("\n")[0]);
          clearTimeout(timer);
          resolve(port);
        } catch {
          // Not the port line; ignore.
        }
      });
      child.on("error", reject);
    });
  }
});
