import { describe, expect, it, vi } from "vitest";

// The kill switch. Its own file for the same reason
// tests/claudeBackgroundLingerOff.test.ts is: the env is read at module load
// (lib/config.ts), so the suite that asserts the block IS sent can't flip it.
vi.hoisted(() => {
  process.env.CALANDRIA_DELEGATE_COLLECTION = "off";
});

import { buildProjectContext } from "@/lib/agents/shared";
import type { Project, Task } from "@/lib/types";

const project = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "" } as Project;
const task = { id: "t1", agent: "claude", title: "T", description: "", session_id: null, worktree_path: "", generation: 1 } as unknown as Task;

describe("CALANDRIA_DELEGATE_COLLECTION=off", () => {
  it("leaves the session on the CLI's own defaults", () => {
    const ctx = buildProjectContext(project, task);
    expect(ctx).not.toContain("the bulk reads go to a subagent");
    // Only that block goes: the rest of the session prompt is unrelated.
    expect(ctx).toContain("Background shell tasks");
    expect(ctx).toContain("suggest_task");
  });
});
