// POST /api/tasks/[id]/file — the document collaboration modal's "write my
// edits straight into the worktree" path, GET's twin. What it must hold:
// the same path confinement as the read, no writes under a live turn (the
// agent owns the worktree until it ends), and no write over a file that
// moved since the modal loaded it (`original` is the modal's copy; the
// current text rides back on the refusal).

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createProject, createTask, updateTask } from "@/lib/store";
import { claimTurn, unregisterTurn } from "@/lib/abort";
import { GET, POST } from "@/app/api/tasks/[id]/file/route";
import { MAX_COLLAB_BYTES } from "@/lib/worktreeFile";
import { makeRepo, tmpDir, uid } from "./helpers";

const DOC = "# Setup\n\nInstall the CLI.\n";

async function post(id: string, body: unknown) {
  const req = new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await POST(req, { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}
async function get(id: string, rel: string) {
  const res = await GET(new Request(`http://x/api?path=${encodeURIComponent(rel)}`), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

let taskId: string;
let worktree: string;
let held: AbortController | null = null;

beforeEach(async () => {
  const repo = await makeRepo();
  const projectId = createProject({ name: `collab-write-${uid()}`, repo_path: repo, branch: "main" }).id;
  taskId = createTask({ project_id: projectId, title: "T" }).id;
  // The route only needs a directory the task row points at; the worktree
  // being a real git checkout is the runner's concern, not this route's.
  worktree = tmpDir("wt-");
  fs.mkdirSync(path.join(worktree, "docs"));
  fs.writeFileSync(path.join(worktree, "docs", "setup.md"), DOC);
  updateTask(taskId, { worktree_path: worktree, started: 1 });
});

afterEach(() => {
  if (held) { unregisterTurn(taskId, held); held = null; }
});

describe("POST /api/tasks/[id]/file", () => {
  it("writes the edited text when the file still matches what the modal loaded", async () => {
    const edited = DOC + "\nRun `calandria init` next.\n";
    const { status, body } = await post(taskId, { path: "docs/setup.md", original: DOC, content: edited });
    expect(status).toBe(200);
    expect(body).toEqual({ path: "docs/setup.md", size: Buffer.byteLength(edited) });
    expect(fs.readFileSync(path.join(worktree, "docs", "setup.md"), "utf8")).toBe(edited);
    // The read half sees the write — the modal reopens on the new text.
    expect((await get(taskId, "docs/setup.md")).body.content).toBe(edited);
  });

  it("refuses while a turn is running, and leaves the file alone", async () => {
    held = claimTurn(taskId);
    expect(held).not.toBeNull();
    const { status, body } = await post(taskId, { path: "docs/setup.md", original: DOC, content: "# Clobbered\n" });
    expect(status).toBe(409);
    expect(body.error).toMatch(/turn is running/);
    expect(fs.readFileSync(path.join(worktree, "docs", "setup.md"), "utf8")).toBe(DOC);
    // …and is allowed again the moment the turn releases the slot.
    unregisterTurn(taskId, held!);
    held = null;
    expect((await post(taskId, { path: "docs/setup.md", original: DOC, content: "# Fine\n" })).status).toBe(200);
  });

  it("refuses when the file changed since it was loaded, returning the current text", async () => {
    const moved = DOC + "\nThe agent added this line.\n";
    fs.writeFileSync(path.join(worktree, "docs", "setup.md"), moved);
    const { status, body } = await post(taskId, { path: "docs/setup.md", original: DOC, content: DOC + "\nMy edit.\n" });
    expect(status).toBe(409);
    expect(body.error).toMatch(/changed since/);
    expect(body.current).toBe(moved);
    expect(fs.readFileSync(path.join(worktree, "docs", "setup.md"), "utf8")).toBe(moved);
  });

  it("confines writes to the worktree exactly like the read does", async () => {
    const outside = tmpDir("outside-");
    fs.writeFileSync(path.join(outside, "secret.md"), "nope\n");
    // A FILE symlink needs Developer Mode or elevation on Windows (a junction
    // stands in only for a directory one), so its absence there is a fixture
    // limitation, not a result — the link case below is conditioned on it.
    let linked = true;
    try {
      fs.symlinkSync(path.join(outside, "secret.md"), path.join(worktree, "docs", "link.md"));
    } catch {
      linked = false;
    }
    const attempt = (p: string) => post(taskId, { path: p, original: "nope\n", content: "pwned\n" });
    expect((await attempt("../" + path.basename(outside) + "/secret.md")).status).toBe(400);
    expect((await attempt(path.join(outside, "secret.md"))).status).toBe(400);
    // symlink out: reads as nonexistent, never followed
    if (linked) expect((await attempt("docs/link.md")).status).toBe(404);
    expect((await attempt("docs/missing.md")).status).toBe(404); // creating files is the agent's job
    expect((await attempt("docs")).status).toBe(400);
    expect(fs.readFileSync(path.join(outside, "secret.md"), "utf8")).toBe("nope\n");
    expect(fs.existsSync(path.join(worktree, "docs", "missing.md"))).toBe(false);
  });

  it("rejects a malformed body, an oversized write, and a task without a worktree", async () => {
    expect((await post(taskId, { path: "docs/setup.md", content: "x" })).status).toBe(400);
    expect((await post(taskId, { path: "docs/setup.md", original: DOC, content: "x".repeat(MAX_COLLAB_BYTES + 1) })).status).toBe(413);
    updateTask(taskId, { worktree_path: "" });
    expect((await post(taskId, { path: "docs/setup.md", original: DOC, content: "x" })).status).toBe(409);
    expect((await post("nope", { path: "docs/setup.md", original: DOC, content: "x" })).status).toBe(404);
  });
});
