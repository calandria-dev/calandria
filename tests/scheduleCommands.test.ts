import { describe, expect, it } from "vitest";
import { isRegistered, slashCommandOf, suggestionsFor } from "@/lib/schedule/commands";

describe("slashCommandOf", () => {
  it("extracts a leading slash command", () => {
    expect(slashCommandOf("/jira-tasks")).toBe("jira-tasks");
    expect(slashCommandOf("  /jira-tasks  ")).toBe("jira-tasks");
    expect(slashCommandOf("/ce-aura:jira-tasks")).toBe("ce-aura:jira-tasks");
    expect(slashCommandOf("/jira-tasks --since yesterday")).toBe("jira-tasks");
  });

  it("is null for an ordinary prompt", () => {
    expect(slashCommandOf("Triage my Jira tickets")).toBeNull();
    expect(slashCommandOf("look in ./src and /etc")).toBeNull();
    expect(slashCommandOf("")).toBeNull();
  });
});

describe("isRegistered", () => {
  const registry = ["jira", "confluence", "superpowers:brainstorming", "jira-tasks"];

  it("matches an exact registration", () => {
    expect(isRegistered("jira-tasks", registry)).toBe(true);
    expect(isRegistered("superpowers:brainstorming", registry)).toBe(true);
  });

  it("rejects a near miss rather than guessing", () => {
    // This is the whole point: the CLI answers "Unknown command" with
    // subtype "success", so a typo would otherwise record a green check.
    expect(isRegistered("jira-taks", registry)).toBe(false);
    expect(isRegistered("jira-tasks-daily", registry)).toBe(false);
  });

  it("offers near misses so the editor can correct them", () => {
    expect(suggestionsFor("jira-taks", registry)).toContain("jira-tasks");
    expect(suggestionsFor("brainstorming", registry)).toContain("superpowers:brainstorming");
  });
});
