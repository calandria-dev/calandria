import { describe, expect, it } from "vitest";
import { isRegistered, slashCommandOf, suggestionsFor } from "@/lib/schedule/commands";

describe("slashCommandOf", () => {
  it("extracts a leading slash command", () => {
    expect(slashCommandOf("/jira-tasks")).toBe("jira-tasks");
    expect(slashCommandOf("  /jira-tasks  ")).toBe("jira-tasks");
    expect(slashCommandOf("/ce-aura:jira-tasks")).toBe("ce-aura:jira-tasks");
    expect(slashCommandOf("/jira-tasks --since yesterday")).toBe("jira-tasks");
  });

  it("over-matches a prompt that merely STARTS with a filesystem path — a known false positive", () => {
    // Documented (not fixed) in app/orchestrator/Schedules.tsx and
    // docs/FEATURES.md: a leading "/etc/..." reads as the command "etc", which
    // would make validatePrompt() report it as unknown even though this is a
    // perfectly ordinary prompt, not a slash command at all. The editor's fix
    // is to never hard-block Save on a validation failure — this test just
    // pins that the false positive is real, so that non-blocking behavior
    // isn't protecting against a hypothetical.
    expect(slashCommandOf("/etc/passwd, tell me what's in it")).toBe("etc");
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
