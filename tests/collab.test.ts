import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCollabPacket, collabPatch, isMarkdownPath, locateQuote, worktreeRelative } from "../lib/collab";
import { blobSha, resolveWorktreeFile } from "../lib/worktreeFile";
import { describeToolUse } from "../lib/agents/shared";
import { createProject, createTask, updateTask } from "../lib/store";
import { GET as fileRoute } from "../app/api/tasks/[id]/file/route";
import { git, makeRepo, tmpDir, writeFile } from "./helpers";

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
    // Omitted mode is the patch contract, so existing callers of the builder see no behavior change.
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
    // A FILE symlink needs Developer Mode or elevation on Windows (a junction
    // only stands in for a directory one), so its absence there is a fixture
    // limitation, not a result. The link assertion below is conditioned on it.
    let linked = true;
    try {
      fs.symlinkSync(path.join(outside, "secret.md"), path.join(wt, "docs", "link.md"));
    } catch {
      linked = false;
    }

    expect(resolveWorktreeFile(wt, "docs/a.md")).toBe(fs.realpathSync(path.join(wt, "docs", "a.md")));
    expect(resolveWorktreeFile(wt, "docs/../docs/a.md")).toBeNull();
    expect(resolveWorktreeFile(wt, "../" + path.basename(outside) + "/secret.md")).toBeNull();
    expect(resolveWorktreeFile(wt, path.join(outside, "secret.md"))).toBeNull();
    if (linked) expect(resolveWorktreeFile(wt, "docs/link.md")).toBeNull();
    expect(resolveWorktreeFile(wt, "docs/missing.md")).toBeNull();
    expect(resolveWorktreeFile(wt, "")).toBeNull();
  });
});

// The transcript's Collaborate button is keyed on the path the agent wrote,
// not on git status, which is what lets a gitignored doc open. The tool
// normalizer names the file, the runner stores it worktree-relative (or not
// at all), and the file route serves anything inside the worktree, ignored
// or not, while still refusing everything outside it.
describe("worktreeRelative", () => {
  it("strips the worktree prefix and refuses anything outside it", () => {
    expect(worktreeRelative("/wt/a", "/wt/a/docs/x.md")).toBe("docs/x.md");
    expect(worktreeRelative("/wt/a/", "/wt/a/scratch/notes.md")).toBe("scratch/notes.md");
    expect(worktreeRelative("/wt/a", "docs/x.md")).toBe("docs/x.md"); // relative = relative to the cwd, the worktree
    expect(worktreeRelative("/wt/a", "./docs//x.md")).toBe("docs/x.md");
    expect(worktreeRelative("/wt/a", "/wt/a")).toBeNull(); // the root itself is no file
    expect(worktreeRelative("/wt/a", "/wt/ab/x.md")).toBeNull(); // sibling with a shared prefix
    expect(worktreeRelative("/wt/a", "/etc/passwd")).toBeNull();
    expect(worktreeRelative("/wt/a", "../a/x.md")).toBeNull(); // `..` is a probe, never a spelling
    expect(worktreeRelative("/wt/a", "/wt/a/../a/x.md")).toBeNull();
    expect(worktreeRelative("", "/wt/a/x.md")).toBeNull(); // no worktree yet
    expect(worktreeRelative("/wt/a", "")).toBeNull();
  });

  // A drive-letter path must be read as absolute, not fall into the relative
  // branch: a file plainly inside the worktree must not 404, and a path
  // outside it must be refused, not merely missed. Asserted on every
  // platform, not skipped off win32: the function is pure string work and
  // takes its dialect from the shape of the paths, so a Windows spelling
  // means the same thing wherever the test runs.
  it("reads a Windows absolute path as absolute", () => {
    expect(worktreeRelative("C:\\wt\\a", "C:\\wt\\a\\docs\\x.md")).toBe("docs/x.md");
    expect(worktreeRelative("C:\\wt\\a", "C:/wt/a/docs/x.md")).toBe("docs/x.md"); // git's spelling
    expect(worktreeRelative("C:\\wt\\a", "C:\\other\\secret.md")).toBeNull();
    expect(worktreeRelative("C:\\wt\\a", "D:\\wt\\a\\x.md")).toBeNull(); // another volume
    expect(worktreeRelative("C:\\wt\\a", "C:\\wt\\ab\\x.md")).toBeNull(); // shared prefix
    expect(worktreeRelative("C:\\wt\\a", "C:\\wt\\a")).toBeNull(); // the root itself
    expect(worktreeRelative("C:\\wt\\a", "C:\\wt\\a\\..\\b\\x.md")).toBeNull();
    expect(worktreeRelative("C:\\wt\\a", "docs\\x.md")).toBe("docs/x.md"); // still relative
  });

  it("case-folds containment for a Windows worktree, and only there", () => {
    // NTFS is case-insensitive, so these are one directory and the file is
    // inside it (lib/paths.ts makes the same call for the same reason).
    expect(worktreeRelative("C:\\WT\\A", "c:\\wt\\a\\docs\\x.md")).toBe("docs/x.md");
    // POSIX filesystems are case-SENSITIVE, and folding there would merge two
    // paths that really can differ, so a case mismatch stays outside.
    expect(worktreeRelative("/WT/A", "/wt/a/docs/x.md")).toBeNull();
  });
});

describe("describeToolUse names the file a writing call touched", () => {
  it("only for Write and Edit", () => {
    expect(describeToolUse("Write", { file_path: "/wt/a/scratch/notes.md", content: "x" }).file).toBe("/wt/a/scratch/notes.md");
    expect(describeToolUse("Edit", { file_path: "/wt/a/README.md", old_string: "a", new_string: "b" }).file).toBe("/wt/a/README.md");
    expect(describeToolUse("NotebookEdit", { notebook_path: "/wt/a/n.ipynb", new_source: "" }).file).toBeUndefined();
    expect(describeToolUse("Read", { file_path: "/wt/a/README.md" }).file).toBeUndefined();
    expect(describeToolUse("Bash", { command: "cat x" }).file).toBeUndefined();
  });
});

describe("GET /api/tasks/[id]/file", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const get = (id: string, p: string) => fileRoute(new Request(`http://x/api/tasks/${id}/file?path=${encodeURIComponent(p)}`), params(id));

  it("serves a gitignored file inside the worktree and still refuses paths outside it", async () => {
    const wt = await makeRepo();
    writeFile(wt, ".gitignore", "scratch/\n");
    await git(wt, "add", "-A");
    await git(wt, "commit", "-m", "ignore scratch");
    writeFile(wt, "scratch/notes.md", "# Scratch notes\n");
    // Sanity: git really does hide it from what the diff lists.
    expect(await git(wt, "ls-files", "--others", "--exclude-standard")).toBe("");
    expect(await git(wt, "status", "--porcelain", "--ignored")).toContain("!! scratch/");

    const outside = tmpDir("outside-");
    fs.writeFileSync(path.join(outside, "secret.md"), "nope\n");

    const project = createProject({ name: "CollabRoute" });
    const task = createTask({ project_id: project.id, title: "T" });
    updateTask(task.id, { worktree_path: wt });

    const ok = await get(task.id, "scratch/notes.md");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ path: "scratch/notes.md", content: "# Scratch notes\n" });

    expect((await get(task.id, path.join(outside, "secret.md"))).status).toBe(400);
    expect((await get(task.id, "../" + path.basename(outside) + "/secret.md")).status).toBe(400);
    expect((await get(task.id, "scratch/../../" + path.basename(outside) + "/secret.md")).status).toBe(400);
    expect((await get(task.id, "scratch/missing.md")).status).toBe(404);
  });
});

describe("blobSha", () => {
  // The document comment anchor is this value, computed in-process instead of
  // shelling out to `git hash-object` on every file read. Pinned here against
  // the real thing so it can never drift from what git itself would compute
  // for the same bytes.
  it("matches `git hash-object` for a UTF-8 file with a non-ASCII character", async () => {
    const dir = tmpDir("blobsha-");
    await git(dir, "init", "-b", "main");
    const abs = path.join(dir, "notes.md");
    fs.writeFileSync(abs, "café — naïve\n", "utf8");
    const expected = (await git(dir, "hash-object", abs)).trim();
    expect(blobSha(fs.readFileSync(abs))).toBe(expected);
  });

  it("matches `git hash-object` for an empty file", async () => {
    const dir = tmpDir("blobsha-");
    await git(dir, "init", "-b", "main");
    const abs = path.join(dir, "empty.md");
    fs.writeFileSync(abs, "");
    const expected = (await git(dir, "hash-object", abs)).trim();
    expect(expected).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(blobSha(fs.readFileSync(abs))).toBe(expected);
  });
});
