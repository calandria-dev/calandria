// What the composer's "/" menu offers, pinned.
//
// The bug: the menu was a hardcoded one-element array, so 58 of the 59 commands
// a Claude session really expands were undiscoverable. The regression risk now
// runs the OTHER way — a denylist that quietly grows until it's hiding the
// user's own commands again — so the default-show behavior is what most of
// these assert.

import { describe, it, expect } from "vitest";
import { visibleAgentCommands } from "@/lib/agentCommands";
import type { AgentCommand } from "@/lib/agents/types";

const cmd = (name: string, extra: Partial<AgentCommand> = {}): AgentCommand => ({
  name,
  description: `${name} description`,
  ...extra,
});

describe("visibleAgentCommands", () => {
  it("shows an ordinary command untouched", () => {
    const out = visibleAgentCommands([cmd("simplify", { argumentHint: "<path>" })]);
    expect(out).toEqual([{ name: "simplify", description: "simplify description", argumentHint: "<path>" }]);
  });

  it("keeps unknown commands — the default is show, not hide", () => {
    // A command nobody anticipated is exactly the case the original bug ate.
    const out = visibleAgentCommands([cmd("some-brand-new-user-command"), cmd("acme:deploy")]);
    expect(out.map((c) => c.name)).toEqual(["some-brand-new-user-command", "acme:deploy"]);
  });

  it("drops the agent's own /clear so one name can't mean two things", () => {
    // Calandria's /clear summarizes + starts the next session generation; the
    // CLI's does not. The composer supplies ours.
    expect(visibleAgentCommands([cmd("clear")])).toEqual([]);
  });

  it("drops run-control commands the task UI owns", () => {
    const out = visibleAgentCommands([cmd("model"), cmd("effort"), cmd("fast"), cmd("compact")]);
    // /compact stays: it does something real and Calandria has no equivalent.
    expect(out.map((c) => c.name)).toEqual(["compact"]);
  });

  it("drops the CLI's internal machinery", () => {
    const out = visibleAgentCommands([cmd("__remote-workflow"), cmd("workflow-launch-exec"), cmd("usage")]);
    expect(out.map((c) => c.name)).toEqual(["usage"]);
  });

  it("keeps commands that merely have no effect here", () => {
    // Hiding a working command is a far worse failure than listing an inert
    // one, so /color and friends are deliberately NOT denied.
    const out = visibleAgentCommands([cmd("color"), cmd("rename")]);
    expect(out.map((c) => c.name)).toEqual(["color", "rename"]);
  });

  it("normalizes a leading slash and ignores blank names", () => {
    const out = visibleAgentCommands([cmd("/verify"), cmd("   "), cmd("/clear")]);
    expect(out.map((c) => c.name)).toEqual(["verify"]);
  });

  it("dedupes by name, keeping the first", () => {
    const out = visibleAgentCommands([cmd("run", { description: "first" }), cmd("run", { description: "second" })]);
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe("first");
  });

  it("carries aliases through so the menu can match on them", () => {
    const out = visibleAgentCommands([cmd("usage", { aliases: ["cost", "stats"] })]);
    expect(out[0].aliases).toEqual(["cost", "stats"]);
  });

  it("sorts plain commands before namespaced ones, alphabetically within each", () => {
    const out = visibleAgentCommands([
      cmd("superpowers:writing-plans"),
      cmd("verify"),
      cmd("code-review:code-review"),
      cmd("batch"),
    ]);
    expect(out.map((c) => c.name)).toEqual([
      "batch",
      "verify",
      "code-review:code-review",
      "superpowers:writing-plans",
    ]);
  });

  it("returns nothing for a driver with no commands", () => {
    expect(visibleAgentCommands([])).toEqual([]);
  });
});
