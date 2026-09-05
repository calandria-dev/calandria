// Pins what the composer's "/" menu offers. The default is to show a
// command; a denylist growing to hide commands it should not is the
// regression these tests guard against, so most of them assert the
// default-show behavior.

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
    // An unrecognized command name still passes through unmodified.
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
    // Hiding a working command is a worse failure than listing an inert one,
    // so /color and friends are not denied.
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

  it("sorts an MCP server's prompts into the same long tail", () => {
    // mcp__server__prompt is a namespace like plugin:. A fleet of servers
    // arrives in bulk under one prefix, and none of it is what a user hunting
    // /verify from memory is scrolling past.
    const out = visibleAgentCommands([
      cmd("mcp__stash__analyze-performer"),
      cmd("verify"),
      cmd("code-review:code-review"),
    ]);
    expect(out.map((c) => c.name)).toEqual([
      "verify",
      "code-review:code-review",
      "mcp__stash__analyze-performer",
    ]);
  });

  it("returns nothing for a driver with no commands", () => {
    expect(visibleAgentCommands([])).toEqual([]);
  });
});
