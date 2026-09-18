// Drives one turn of the Codex hook harness (docs/CODEX_HOOK_HARNESS.md):
// starts the loopback model fixture, trusts the seeded hook through the
// driver's own review path, and runs a turn through codexDriver.runTurn().
//
// One call is one case. The harness root the paths name holds that case's
// evidence, so a matrix of cases keeps each run's ledger and hook log apart.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { codexDriver } from "@/lib/agents/codex/driver";
import type { AgentHookInventoryResult } from "@/lib/agents/types";
import { createProject, createTask, updateProject } from "@/lib/store";
import type { StreamEvent } from "@/lib/types";
import { writePlan, HARNESS_FIXTURES, type HarnessPaths, type HarnessStep } from "./seed";

export interface HarnessTurn {
  events: StreamEvent[];
  /** What listHooks() reported immediately before the turn started. */
  inventory: AgentHookInventoryResult;
}

export interface HarnessTurnOptions {
  /**
   * What to do with every hook the inventory reports, before the turn. "trust"
   * pins the current hash so the CLI runs it, the call Settings makes. "none"
   * leaves the hook unreviewed, which is what an untrusted or a
   * project-untrusted control wants.
   */
  review?: "trust" | "disable" | "none";
  /** Runs after the review and before the turn, for mutating the hook on disk. */
  beforeTurn?: (p: HarnessPaths) => void;
}

/** Start the loopback model fixture and resolve the port it bound. */
function startModelServer(p: HarnessPaths): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HARNESS_FIXTURES, "model-server.mjs")], {
      env: {
        ...process.env,
        CALANDRIA_HARNESS_PLAN: p.plan,
        CALANDRIA_HARNESS_REQUESTS: p.requests,
        CALANDRIA_HARNESS_TOOL_SCHEMAS: p.toolSchemas,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const timer = setTimeout(() => reject(new Error("model fixture did not report a port")), 10_000);
    child.stdout!.on("data", (c: Buffer) => {
      try {
        const { port } = JSON.parse(c.toString().trim().split("\n")[0]);
        clearTimeout(timer);
        resolve({ child, port });
      } catch {
        // Not the port line; ignore.
      }
    });
    child.on("error", reject);
  });
}

/**
 * Run one harness turn against `steps` and return every StreamEvent it
 * produced. The transcript and the hook inventory are written into the case's
 * root beside the ledger, so the evidence for a case is self-contained.
 */
export async function runHarnessTurn(
  p: HarnessPaths,
  steps: HarnessStep[],
  prompt: string,
  { review = "trust", beforeTurn }: HarnessTurnOptions = {},
): Promise<HarnessTurn> {
  process.env.CODEX_HOME = p.codexHome;
  process.env.CALANDRIA_HARNESS_HOOK_LOG = p.hookLog;
  process.env.CALANDRIA_HARNESS_HOOK_DENY = p.denyMarker;
  // Every hook run posts a notice, not just a notable one: the matrix reads
  // the allowed cases off the transcript too.
  process.env.CALANDRIA_CODEX_HOOK_TRACE = "1";
  writePlan(p.plan, steps);

  const { child, port } = await startModelServer(p);
  try {
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.CODEX_MODEL = p.model;
    delete process.env.OPENAI_API_KEY;

    const first = await codexDriver.listHooks!(p.workspace);
    const hooks = (first.inventory?.scopes ?? []).flatMap((s) => s.hooks);
    if (review !== "none" && hooks.length) {
      await codexDriver.reviewHooks!(
        p.workspace,
        hooks.flatMap((h) =>
          review === "disable"
            ? [{ key: h.key, action: "trust" as const }, { key: h.key, action: "disable" as const }]
            : [{ key: h.key, action: "trust" as const }],
        ),
      );
    }
    beforeTurn?.(p);
    // Re-read after the review and any mutation: this is the state the turn
    // actually runs under, which is what a control case is measuring.
    const listed = await codexDriver.listHooks!(p.workspace);
    fs.writeFileSync(path.join(p.root, "hook-inventory.json"), `${JSON.stringify(listed, null, 2)}\n`);

    const project = createProject({ name: `Codex hook harness ${path.basename(p.root)}`, repo_path: p.workspace });
    updateProject(project.id, { default_agent: "codex" });
    const task = createTask({
      project_id: project.id,
      title: "hook-harness",
      description: "",
      permission_mode: "bypassPermissions",
    });
    const events: StreamEvent[] = [];
    for await (const ev of codexDriver.runTurn(task, project, prompt)) events.push(ev);
    fs.writeFileSync(path.join(p.root, "transcript.json"), `${JSON.stringify(events, null, 2)}\n`);
    return { events, inventory: listed };
  } finally {
    child.kill();
  }
}
