import { describe, expect, it } from "vitest";
import { buildProjectContext } from "@/lib/agents/shared";
import type { Project, Task } from "@/lib/types";

// The delegation directive lives in the session prompt rather than in a
// CLAUDE.md file, because the CLAUDE.md version was measured firing after the
// sweep it was meant to replace, or not at all (docs/DELEGATION.md).
// What this file pins is the three decisions that came out of that measurement:
// it is there at all, it is LAST, and it is only sent to an agent that has
// subagents to dispatch.

const project = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "" } as Project;
const taskFor = (agent: string) =>
  ({ id: `t-${agent}`, agent, title: "T", description: "", session_id: null, worktree_path: "", generation: 1 }) as unknown as Task;

describe("collection-delegation directive", () => {
  it("reaches a Claude session, with the count trigger and the synchronous-dispatch rule", () => {
    const ctx = buildProjectContext(project, taskFor("claude"));
    expect(ctx).toContain("the bulk reads go to a subagent");
    // The trigger is a COUNT. The CLAUDE.md version qualified it with "against
    // the same question", which a model can judge false of every command it
    // runs, so the condition never fired by its own reckoning.
    expect(ctx).toContain("Once you have run two read-only commands");
    expect(ctx).not.toContain("same question");
    // Backgrounded, the sub-answer never arrives inside the turn and the sweep
    // is lost while the metric improves — measured, hence "required".
    expect(ctx).toContain("`run_in_background: false` is required and is not the default");
    expect(ctx).toContain('Agent(subagent_type: "Explore", model: "haiku", run_in_background: false)');
  });

  it("is the LAST thing in the prompt", () => {
    // Placement is the whole point of moving it out of CLAUDE.md: the append
    // lands after the CLI's own instructions ("do your work through the Bash
    // tool", "do not call the AgentTool unless the user requested it"), and it
    // is countermanding them.
    const ctx = buildProjectContext(project, taskFor("claude"));
    expect(ctx.trimEnd().endsWith("run the thing and read the number.")).toBe(true);
  });

  it("is omitted for an agent with no subagents to dispatch", () => {
    // `codex exec` has no subagent verb, so the block would describe a tool the
    // session doesn't have. Everything else it needs still goes out.
    const ctx = buildProjectContext(project, taskFor("codex"));
    expect(ctx).not.toContain("the bulk reads go to a subagent");
    expect(ctx).toContain("suggest_task");
    expect(ctx).toContain("expose_service");
  });
});
