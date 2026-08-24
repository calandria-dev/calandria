import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCollabPacket, collabPatch, isMarkdownPath, locateQuote } from "../lib/collab";
import { resolveWorktreeFile } from "../lib/worktreeFile";
import { tmpDir } from "./helpers";

const DOC = [
  "# Setup guide",
  "",
  "Install the **CLI** first, then run `init`.",
  "",
  "## Configuration",
  "",
  "- Set `PORT` to the port you want",
  "- Set [BASE_URL](https://example.com) when behind a proxy",
  "",
  "The server reads both at boot and",
  "never re-reads them while running.",
  "",
].join("\n");

describe("isMarkdownPath", () => {
  it("matches markdown extensions case-insensitively and nothing else", () => {
    expect(isMarkdownPath("docs/README.md")).toBe(true);
    expect(isMarkdownPath("notes.MDX")).toBe(true);
    expect(isMarkdownPath("app/page.tsx")).toBe(false);
    expect(isMarkdownPath("Makefile")).toBe(false);
  });
});

describe("locateQuote", () => {
  it("finds a verbatim source substring", () => {
    expect(locateQuote(DOC, "reads both at boot")).toEqual({ lineStart: 10, lineEnd: 10 });
  });

  it("finds rendered text the markdown syntax reshaped", () => {
    // Rendered view drops the ** and backticks.
    expect(locateQuote(DOC, "Install the CLI first, then run init.")).toEqual({ lineStart: 3, lineEnd: 3 });
    // Link text without its URL, list marker gone.
    expect(locateQuote(DOC, "Set BASE_URL when behind a proxy")).toEqual({ lineStart: 8, lineEnd: 8 });
  });

  it("spans a selection that crosses a soft line break", () => {
    expect(locateQuote(DOC, "at boot and never re-reads")).toEqual({ lineStart: 10, lineEnd: 11 });
  });

  it("returns null for text that isn't there", () => {
    expect(locateQuote(DOC, "kubernetes")).toBeNull();
    expect(locateQuote(DOC, "   ")).toBeNull();
  });
});

describe("collabPatch", () => {
  it("is empty when nothing changed and a unified diff otherwise", () => {
    expect(collabPatch("a.md", DOC, DOC)).toBe("");
    const edited = DOC.replace("never re-reads them", "re-reads them on SIGHUP");
    const p = collabPatch("docs/a.md", DOC, edited);
    expect(p.startsWith("--- a/docs/a.md")).toBe(true); // no jsdiff Index/==== banner
    expect(p).toContain("+++ b/docs/a.md");
    expect(p).toContain("-never re-reads them while running.");
    expect(p).toContain("+re-reads them on SIGHUP while running.");
  });
});

describe("buildCollabPacket", () => {
  it("returns null when there is nothing to send", () => {
    expect(buildCollabPacket({ file: "a.md", original: DOC, edited: DOC, comments: [], general: "  " })).toBeNull();
    // A comment with an empty body doesn't count.
    expect(buildCollabPacket({ file: "a.md", original: DOC, edited: DOC, comments: [{ quote: "x", comment: " " }], general: "" })).toBeNull();
  });

  it("stacks edits, located passage comments and general notes", () => {
    const edited = DOC.replace("Install the **CLI** first", "Install the **CLI** and **SDK** first");
    const packet = buildCollabPacket({
      file: "docs/setup.md",
      original: DOC,
      edited,
      comments: [
        { quote: "Set PORT to the port you want", comment: "Say which port is the default.", heading: "Configuration" },
        { quote: "text that no longer exists", comment: "dangling", heading: "Configuration" },
      ],
      general: "Overall: too terse for a first-time reader.",
    });
    expect(packet).not.toBeNull();
    const p = packet as string;
    expect(p.startsWith("Document review of `docs/setup.md`")).toBe(true);
    expect(p).toContain("## My edits");
    expect(p).toContain("```diff\n");
    expect(p).toContain("+Install the **CLI** and **SDK** first");
    expect(p).toContain("Line numbers refer to the file AFTER my patch is applied.");
    expect(p).toContain('1. **line 7, under "Configuration":**\n> Set PORT to the port you want\n\n   Say which port is the default.');
    expect(p).toContain('2. **location not found in source, under "Configuration":**');
    expect(p).toContain("## General comments\nOverall: too terse for a first-time reader.");
  });

  it("in direct mode, presents the diff as context and forbids re-applying it", () => {
    const edited = DOC.replace("never re-reads them", "re-reads them on SIGHUP");
    const p = buildCollabPacket({
      file: "docs/setup.md",
      original: DOC,
      edited,
      comments: [{ quote: "Setup guide", comment: "Rename to Quick start" }],
      general: "",
      mode: "direct",
    }) as string;
    expect(p).toContain("## My edits");
    expect(p).toContain("I edited `docs/setup.md` directly in the worktree");
    expect(p).toContain("do NOT apply this diff again");
    expect(p).toContain("+re-reads them on SIGHUP while running.");
    // The file on disk IS the edited text, so comments locate against the current file.
    expect(p).toContain("Line numbers refer to the current file.");
    expect(p).not.toContain("Apply this patch");
    // Omitted mode is the patch contract — nothing that previously called the builder changes behavior.
    expect(buildCollabPacket({ file: "a.md", original: DOC, edited, comments: [], general: "" })).toContain("Apply this patch");
  });

  it("omits the edits section when the text is untouched", () => {
    const p = buildCollabPacket({ file: "a.md", original: DOC, edited: DOC, comments: [{ quote: "Setup guide", comment: "Rename to Quick start" }], general: "" });
    expect(p).not.toContain("## My edits");
    expect(p).toContain("Line numbers refer to the current file.");
    expect(p).toContain("1. **line 1:**");
  });
});

describe("resolveWorktreeFile", () => {
  it("confines reads to the worktree, symlinks included", () => {
    const wt = tmpDir("wt-");
    const outside = tmpDir("outside-");
    fs.mkdirSync(path.join(wt, "docs"));
    fs.writeFileSync(path.join(wt, "docs", "a.md"), "# a\n");
    fs.writeFileSync(path.join(outside, "secret.md"), "nope\n");
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(wt, "docs", "link.md"));

    expect(resolveWorktreeFile(wt, "docs/a.md")).toBe(fs.realpathSync(path.join(wt, "docs", "a.md")));
    expect(resolveWorktreeFile(wt, "docs/../docs/a.md")).toBeNull();
    expect(resolveWorktreeFile(wt, "../" + path.basename(outside) + "/secret.md")).toBeNull();
    expect(resolveWorktreeFile(wt, path.join(outside, "secret.md"))).toBeNull();
    expect(resolveWorktreeFile(wt, "docs/link.md")).toBeNull();
    expect(resolveWorktreeFile(wt, "docs/missing.md")).toBeNull();
    expect(resolveWorktreeFile(wt, "")).toBeNull();
  });
});
