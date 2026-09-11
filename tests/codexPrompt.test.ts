import { describe, it, expect, beforeEach, vi } from "vitest";

// The exec transport is the one that drives @openai/codex-sdk; the default
// app-server transport spawns the real CLI (tests/codexAppServer.test.ts points
// it at a fake). Both take their prompt from the same closure in the driver, so
// mocking the SDK covers the rule for both. Pinned before any import reads
// lib/config.ts.
vi.hoisted(() => {
  process.env.CODEX_TRANSPORT = "exec";
});

// Records the prompt string the driver hands the thread, then replays an empty
// stream.
const { sentPrompt } = vi.hoisted(() => ({ sentPrompt: { last: null as string | null } }));

vi.mock("@openai/codex-sdk", () => {
  class FakeThread {
    id: string | null;
    constructor(id?: string | null) {
      this.id = id ?? null;
    }
    async runStreamed(prompt: string) {
      sentPrompt.last = prompt;
      return { events: (async function* () {})() };
    }
  }
  class Codex {
    startThread() {
      return new FakeThread();
    }
    resumeThread(id: string) {
      return new FakeThread(id);
    }
  }
  return { Codex };
});

import { codexDriver } from "@/lib/agents/codex/driver";
import { createProject, createTask, getTask } from "@/lib/store";
import { ATTACHMENT_NUDGE, attachmentMarker } from "@/lib/uploadTypes";
import type { Task } from "@/lib/types";

/** The prompt the driver actually sent, for a turn carrying `userText`. */
async function sent(userText: string, over: Partial<Task> = {}): Promise<string> {
  const project = createProject({ name: `CodexPrompt ${Math.random().toString(36).slice(2)}`, repo_path: "" });
  const row = createTask({ project_id: project.id, title: "T", description: "", agent: "codex" });
  const task = { ...getTask(row.id)!, ...over };
  sentPrompt.last = null;
  for await (const _ of codexDriver.runTurn(task, project, userText)) void _;
  return sentPrompt.last!;
}

beforeEach(() => {
  sentPrompt.last = null;
});

// Chat attachments reach the agent as "[Attached image: /abs/path]" marker
// lines. Without the nudge a Codex session sees a path with no explanation of
// what it is. The nudge is prompt-only: what the runner persists keeps the bare
// marker.
describe("codex chat attachments", () => {
  const marker = attachmentMarker("/tmp/uploads/t1/shot.png");

  it("appends the nudge on a fresh session, after the project context", async () => {
    const prompt = await sent(`look at this\n${marker}`);
    expect(prompt).toContain(marker);
    expect(prompt).toContain(ATTACHMENT_NUDGE);
    expect(prompt.indexOf(ATTACHMENT_NUDGE)).toBeGreaterThan(prompt.indexOf(marker));
  });

  it("appends the nudge on a resumed session too", async () => {
    const prompt = await sent(`look at this\n${marker}`, { session_id: "thread-1" });
    expect(prompt).toContain(marker);
    expect(prompt).toContain(ATTACHMENT_NUDGE);
  });

  it("leaves a message with no marker line alone, on either path", async () => {
    expect(await sent("plain message")).not.toContain(ATTACHMENT_NUDGE);
    expect(await sent("plain message", { session_id: "thread-1" })).not.toContain(ATTACHMENT_NUDGE);
  });
});
