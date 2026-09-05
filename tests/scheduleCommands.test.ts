import { describe, expect, it } from "vitest";
import { isRegistered, slashCommandOf, suggestionsFor } from "@/lib/schedule/commands";

describe("slashCommandOf", () => {
  it("extracts a leading slash command", () => {
    expect(slashCommandOf("/jira-tasks")).toBe("jira-tasks");
    expect(slashCommandOf("  /jira-tasks  ")).toBe("jira-tasks");
    expect(slashCommandOf("/ce-aura:jira-tasks")).toBe("ce-aura:jira-tasks");
    expect(slashCommandOf("/jira-tasks --since yesterday")).toBe("jira-tasks");
  });

  it("reads a leading filesystem path as a path, not as a command", () => {
    // A leading filesystem path has to parse as a path: the same validator
    // runs again at fire time in lib/scheduler.ts, where an unknown command
    // settles the run `failed` and mints nothing, so misparsing it here would
    // fail a saved prompt every morning.
    //
    // A slash command never contains a path separator, so "followed by /" is a
    // clean discriminator.
    expect(slashCommandOf("/etc/passwd, tell me what's in it")).toBeNull();
    expect(slashCommandOf("/usr/local/bin/thing --help")).toBeNull();
    expect(slashCommandOf("  /var/log/system.log is huge")).toBeNull();
  });

  it("still matches the real command forms, including the one-char-shorter trap", () => {
    // With a trailing capture instead of a negative lookahead,
    // /\/([A-Za-z0-9_:-]+)(?!\/)/ backtracks the token by one character and
    // matches "et" out of "/etc/passwd" instead of failing. Pin the boundary
    // cases either side of that.
    expect(slashCommandOf("/etc")).toBe("etc");
    expect(slashCommandOf("/etc, what lives there?")).toBe("etc");
    expect(slashCommandOf("/jira-tasks/")).toBeNull();
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
    // The CLI answers "Unknown command" with subtype "success", so a typo
    // would otherwise record a green check.
    expect(isRegistered("jira-taks", registry)).toBe(false);
    expect(isRegistered("jira-tasks-daily", registry)).toBe(false);
  });

  it("offers near misses so the editor can correct them", () => {
    expect(suggestionsFor("jira-taks", registry)).toContain("jira-tasks");
    expect(suggestionsFor("brainstorming", registry)).toContain("superpowers:brainstorming");
  });
});
