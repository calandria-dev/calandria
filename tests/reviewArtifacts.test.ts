// Review artifact capture and exact reads (WC-12): code pins, document bytes,
// repository identity, and every rejected or changed case in the contract's
// fixture matrix.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as rawGet } from "../app/api/tasks/[id]/reviews/[requestId]/submissions/[submissionId]/artifact/raw/route";
import { GET as artifactGet } from "../app/api/tasks/[id]/reviews/[requestId]/submissions/[submissionId]/artifact/route";
import { GET as listGet } from "../app/api/tasks/[id]/reviews/route";
import { commonDirOf, createPins, normalizeDocumentPath } from "../lib/reviews/artifacts";
import { listTaskReviews, readArtifact } from "../lib/reviews/read";
import { submitReview } from "../lib/reviews/submit";
import { ReviewError, sha256Hex } from "../lib/reviews/types";
import { commitFile, git, uid, writeFile } from "./helpers";
import { codeBody, docBody, reviewTask } from "./reviewFixture";

beforeEach(() => {
  process.env.CALANDRIA_REVIEW_REQUESTS = "1";
});
afterEach(() => {
  delete process.env.CALANDRIA_REVIEW_REQUESTS;
});

async function rejects(p: Promise<unknown>): Promise<ReviewError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ReviewError);
    return e as ReviewError;
  }
  throw new Error("expected a ReviewError");
}

const refs = async (repo: string) => (await git(repo, "for-each-ref", "--format=%(refname)", "refs/calandria/reviews")).split("\n").filter(Boolean);
const params = (f: { taskId: string }, r: { requestId: string; submissionId: string }) => ({ params: Promise.resolve({ id: f.taskId, requestId: r.requestId, submissionId: r.submissionId }) });

describe("code artifacts", () => {
  it("captures base, head and target pins and reads the diff from them after the branch moves and gc runs", async () => {
    const f = await reviewTask();
    const head = await commitFile(f.wt.path, "feature.txt", "feature\n", "add feature");
    const r = await submitReview(f.ctx, codeBody());
    const art = await readArtifact(f.taskId, r.body.requestId, r.body.submissionId);
    expect(art.kind).toBe("code");
    expect(art.manifest).toMatchObject({ headCommitSha: head, taskBranch: f.wt.branch, baseBranch: "main" });
    expect((art.manifest as { baseTipSha: string }).baseTipSha).toBe(await git(f.repo, "rev-parse", "main"));
    expect(art.preview).toMatchObject({ truncated: false, pathCount: 1 });
    expect((art.preview as { text: string }).text).toContain("+feature");
    expect(await refs(f.repo)).toHaveLength(3);

    // Rewrite the task branch away from the submitted head and collect garbage.
    await git(f.wt.path, "reset", "--hard", "main");
    await git(f.repo, "reflog", "expire", "--expire=now", "--all");
    await git(f.repo, "gc", "--prune=now", "-q");
    const again = await readArtifact(f.taskId, r.body.requestId, r.body.submissionId);
    expect((again.preview as { text: string }).text).toContain("+feature");
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("changed");
  });

  it("serves the same artifact through the HTTP routes with the stable error shape", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "a.txt", "a\n", "a");
    const r = await submitReview(f.ctx, codeBody());
    const ok = await artifactGet(new Request("http://x"), params(f, r.body));
    expect(ok.status).toBe(200);
    expect((await ok.json()).artifactId).toBe(r.body.artifactId);
    const bad = await artifactGet(new Request("http://x"), { params: Promise.resolve({ id: f.taskId, requestId: r.body.requestId, submissionId: "nope" }) });
    expect(bad.status).toBe(404);
    expect((await bad.json()).error.code).toBe("not_found");
    const raw = await rawGet(new Request("http://x"), params(f, r.body));
    expect(raw.status).toBe(422);
    const list = await listGet(new Request(`http://x/api/tasks/${f.taskId}/reviews`), { params: Promise.resolve({ id: f.taskId }) });
    expect((await list.json()).requests).toHaveLength(1);
    const none = await listGet(new Request("http://x"), { params: Promise.resolve({ id: "ghost" }) });
    expect(none.status).toBe(404);
  });

  it("rejects dirty tracked, untracked and detached states", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "a.txt", "a\n", "a");
    writeFile(f.wt.path, "a.txt", "changed\n");
    expect((await rejects(submitReview(f.ctx, codeBody()))).code).toBe("dirty_worktree");
    await git(f.wt.path, "checkout", "--", "a.txt");
    writeFile(f.wt.path, "new.txt", "x\n");
    expect((await rejects(submitReview(f.ctx, codeBody()))).code).toBe("dirty_worktree");
    fs.rmSync(path.join(f.wt.path, "new.txt"));
    await git(f.wt.path, "checkout", "--detach");
    expect((await rejects(submitReview(f.ctx, codeBody()))).code).toBe("source_changed");
    expect(await refs(f.repo)).toEqual([]);
  });

  it("ignores gitignored files and says nothing is dirty", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, ".gitignore", "scratch.log\n", "ignore");
    writeFile(f.wt.path, "scratch.log", "noise\n");
    expect((await submitReview(f.ctx, codeBody())).status).toBe(201);
  });

  it("rejects ambiguous merge bases", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "t1.txt", "t1\n", "t1");
    const b1 = await commitFile(f.repo, "b1.txt", "b1\n", "b1");
    await git(f.repo, "merge", "--no-ff", "-m", "m1", f.wt.branch);
    await git(f.wt.path, "merge", "--no-ff", "-m", "m2", b1);
    const err = await rejects(submitReview(f.ctx, codeBody()));
    expect(err.code).toBe("source_changed");
    expect(err.message).toMatch(/several merge bases/);
  });

  it("marks a same-tree new commit and a moved base tip as changed", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "a.txt", "a\n", "a");
    await submitReview(f.ctx, codeBody());
    const view = async () => (await listTaskReviews(f.taskId)).requests[0].applicability;
    expect((await view()).state).toBe("current");
    await git(f.wt.path, "commit", "--allow-empty", "-m", "same tree", "--no-verify");
    expect(await view()).toMatchObject({ state: "changed", reason: expect.stringMatching(/task branch moved/) });
    await git(f.wt.path, "reset", "--hard", "HEAD~1");
    expect((await view()).state).toBe("current");
    await commitFile(f.repo, "other.txt", "o\n", "base moved");
    expect(await view()).toMatchObject({ state: "changed", reason: expect.stringMatching(/base branch moved/) });
  });

  it("deletes only its own pins when the database commit fails", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "a.txt", "a\n", "a");
    await expect(submitReview(f.ctx, codeBody(), { beforeCommit: () => { throw new Error("db down"); } })).rejects.toThrow("db down");
    expect(await refs(f.repo)).toEqual([]);
  });

  it("never overwrites an existing pin", async () => {
    const f = await reviewTask();
    const dir = await commonDirOf(f.wt.path);
    const sha = await git(f.repo, "rev-parse", "main");
    await createPins(dir, "fixed", { base: sha, head: sha, target: sha });
    const other = await commitFile(f.wt.path, "z.txt", "z\n", "z");
    await expect(createPins(dir, "fixed", { base: other, head: other, target: other })).rejects.toBeInstanceOf(ReviewError);
    expect(await git(f.repo, "rev-parse", "refs/calandria/reviews/fixed/head")).toBe(sha);
  });

  it("marks an artifact unavailable when the repository marker is missing or replaced", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "a.txt", "a\n", "a");
    const r = await submitReview(f.ctx, codeBody());
    const dir = await commonDirOf(f.wt.path);
    const marker = path.join(dir, "calandria-review-repository-id");
    const original = fs.readFileSync(marker, "utf8");
    fs.writeFileSync(marker, "someone-else");
    await expect(readArtifact(f.taskId, r.body.requestId, r.body.submissionId)).rejects.toMatchObject({ code: "artifact_unavailable" });
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("unavailable");
    fs.rmSync(marker);
    await expect(readArtifact(f.taskId, r.body.requestId, r.body.submissionId)).rejects.toMatchObject({ code: "artifact_unavailable" });
    fs.writeFileSync(marker, original);
    expect((await readArtifact(f.taskId, r.body.requestId, r.body.submissionId)).kind).toBe("code");
  });

  it("does not adopt a clone that carries a marker the database does not know", async () => {
    const f = await reviewTask();
    const dir = await commonDirOf(f.wt.path);
    fs.writeFileSync(path.join(dir, "calandria-review-repository-id"), "foreign-uuid");
    await commitFile(f.wt.path, "a.txt", "a\n", "a");
    const err = await rejects(submitReview(f.ctx, codeBody()));
    expect(err.code).toBe("artifact_unavailable");
    expect(await refs(f.repo)).toEqual([]);
  });

  it("truncates an oversized diff and labels it", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "big.txt", "x".repeat(60) + "\n" + ("line of text\n").repeat(200_000), "big");
    const r = await submitReview(f.ctx, codeBody());
    const art = await readArtifact(f.taskId, r.body.requestId, r.body.submissionId);
    expect(art.preview).toMatchObject({ truncated: true, reason: "size_limit" });
    expect(art.preview.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("reports a path-limit preview without a diff body", async () => {
    const f = await reviewTask();
    for (let i = 0; i < 1001; i++) writeFile(f.wt.path, `many/f${i}.txt`, `${i}\n`);
    await git(f.wt.path, "add", "-A");
    await git(f.wt.path, "commit", "-m", "many", "--no-verify");
    const r = await submitReview(f.ctx, codeBody());
    const art = await readArtifact(f.taskId, r.body.requestId, r.body.submissionId);
    expect(art.preview).toMatchObject({ text: null, truncated: true, reason: "path_limit", pathCount: 1001 });
  });
});

describe("document artifacts", () => {
  it("preserves BOM, CRLF and non-ASCII bytes exactly and serves them raw", async () => {
    const f = await reviewTask();
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Titre\r\nçà – ünïcode\r\n", "utf8")]);
    writeFile(f.wt.path, "docs/plan.md", bytes);
    const r = await submitReview(f.ctx, docBody());
    const raw = await rawGet(new Request("http://x"), params(f, r.body));
    expect(raw.status).toBe(200);
    expect(Buffer.from(await raw.arrayBuffer()).equals(bytes)).toBe(true);
    expect(raw.headers.get("Content-Type")).toBe("text/markdown;charset=utf-8");
    expect(raw.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(raw.headers.get("ETag")).toBe(`"${sha256Hex(bytes)}"`);
    expect(raw.headers.get("Cache-Control")).toBe("private, no-store");
    const art = await readArtifact(f.taskId, r.body.requestId, r.body.submissionId);
    expect(art.manifest).toMatchObject({ sha256: sha256Hex(bytes), byteLength: bytes.length, realRelativePath: "docs/plan.md", encoding: "utf-8" });
  });

  it("keeps the captured bytes after the file is edited, and flags the review changed", async () => {
    const f = await reviewTask();
    writeFile(f.wt.path, "docs/plan.md", "# v1\n");
    const r = await submitReview(f.ctx, docBody());
    writeFile(f.wt.path, "docs/plan.md", "# v2 draft\n");
    const raw = await rawGet(new Request("http://x"), params(f, r.body));
    expect(await raw.text()).toBe("# v1\n");
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("changed");
  });

  it("allows a dirty worktree for a document (the bytes are the artifact)", async () => {
    const f = await reviewTask();
    writeFile(f.wt.path, "docs/plan.md", "# uncommitted\n");
    writeFile(f.wt.path, "unrelated.txt", "dirty\n");
    expect((await submitReview(f.ctx, docBody())).status).toBe(201);
  });

  it("rejects malformed, traversing, absolute and wrong-extension paths", async () => {
    const f = await reviewTask();
    writeFile(f.wt.path, "docs/plan.md", "x");
    writeFile(f.wt.path, "docs/plan.txt", "x");
    for (const p of ["../outside.md", "docs/../../outside.md", "/etc/passwd.md", "C:\\x.md", "bad\0.md"]) {
      expect((await rejects(submitReview(f.ctx, docBody({ artifact: { kind: "document", path: p } })))).code, p).toBe("bad_request");
    }
    expect((await rejects(submitReview(f.ctx, docBody({ artifact: { kind: "document", path: "docs/plan.txt" } })))).code).toBe("unsupported_artifact");
    expect((await rejects(submitReview(f.ctx, docBody({ artifact: { kind: "document", path: "docs/missing.md" } })))).code).toBe("artifact_not_found");
    expect(normalizeDocumentPath("docs\\sub\\a.md")).toBe("docs/sub/a.md");
  });

  it("rejects a symlink that escapes the worktree and records a retarget inside it", async () => {
    const f = await reviewTask();
    const outside = path.join(path.dirname(f.repo), `outside-${uid()}.md`);
    fs.writeFileSync(outside, "secret\n");
    fs.symlinkSync(outside, path.join(f.wt.path, "escape.md"));
    expect((await rejects(submitReview(f.ctx, docBody({ artifact: { kind: "document", path: "escape.md" } })))).code).toBe("artifact_not_found");

    writeFile(f.wt.path, "one.md", "same\n");
    writeFile(f.wt.path, "two.md", "same\n");
    fs.symlinkSync("one.md", path.join(f.wt.path, "link.md"));
    const r = await submitReview(f.ctx, docBody({ artifact: { kind: "document", path: "link.md" } }));
    const art = await readArtifact(f.taskId, r.body.requestId, r.body.submissionId);
    expect(art.manifest).toMatchObject({ path: "link.md", realRelativePath: "one.md" });
    fs.rmSync(path.join(f.wt.path, "link.md"));
    fs.symlinkSync("two.md", path.join(f.wt.path, "link.md")); // identical bytes, new target
    expect((await listTaskReviews(f.taskId)).requests[0].applicability).toMatchObject({ state: "changed", reason: expect.stringMatching(/resolves elsewhere/) });
  });

  it("rejects oversized and non-UTF-8 documents", async () => {
    const f = await reviewTask();
    writeFile(f.wt.path, "big.md", Buffer.alloc(1024 * 1024 + 1, 0x61));
    expect((await rejects(submitReview(f.ctx, docBody({ artifact: { kind: "document", path: "big.md" } })))).code).toBe("document_too_large");
    writeFile(f.wt.path, "ok.md", Buffer.alloc(1024 * 1024, 0x61));
    expect((await submitReview(f.ctx, docBody({ outputKey: "max", artifact: { kind: "document", path: "ok.md" } }))).status).toBe(201);
    writeFile(f.wt.path, "bad.md", Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    expect((await rejects(submitReview(f.ctx, docBody({ outputKey: "bad", artifact: { kind: "document", path: "bad.md" } })))).code).toBe("invalid_utf8");
  });

  it("rejects a capture a concurrent writer disturbed", async () => {
    const f = await reviewTask();
    writeFile(f.wt.path, "docs/plan.md", "# v1\n");
    const err = await rejects(
      submitReview(f.ctx, docBody(), { beforeVerify: () => writeFile(f.wt.path, "docs/plan.md", "# v1 plus a concurrent edit\n") }),
    );
    expect(err.code).toBe("unstable_capture");
    expect(err.retryable).toBe(true);
    // Replace the inode instead of writing in place.
    const err2 = await rejects(
      submitReview(f.ctx, docBody(), {
        beforeVerify: () => {
          fs.rmSync(path.join(f.wt.path, "docs/plan.md"));
          writeFile(f.wt.path, "docs/plan.md", "# v1\n");
        },
      }),
    );
    expect(err2.code).toBe("unstable_capture");
  });

  it("treats the same bytes at a new path as a different artifact that needs its own review", async () => {
    const f = await reviewTask();
    writeFile(f.wt.path, "docs/plan.md", "# same\n");
    const a = await submitReview(f.ctx, docBody());
    fs.renameSync(path.join(f.wt.path, "docs/plan.md"), path.join(f.wt.path, "docs/renamed.md"));
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("changed");
    const b = await submitReview(f.ctx, docBody({ outputKey: "plan-renamed", artifact: { kind: "document", path: "docs/renamed.md" } }));
    const [ma, mb] = await Promise.all([a, b].map(async (x) => (await readArtifact(f.taskId, x.body.requestId, x.body.submissionId)).manifest as { path: string; sha256: string }));
    expect(ma.sha256).toBe(mb.sha256);
    expect(ma.path).not.toBe(mb.path);
  });

  it("keeps an unrelated commit with the same path and bytes current", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "docs/plan.md", "# stable\n", "plan");
    await submitReview(f.ctx, docBody());
    await commitFile(f.wt.path, "other.txt", "o\n", "unrelated");
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("current");
  });
});
