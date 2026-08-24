// Document collaboration passage comments (task_doc_comments) are persisted
// the moment they're added — the CollabDoc modal's twin of the Changes tab's
// line comments (tests/collab.test.ts covers the packet/quote-location half;
// this file covers storage and the routes). Two things are pinned that a
// naive CRUD wrapper would get wrong:
//   - a SENT comment is read-only server-side: deleteTaskDocComment refuses
//     it (returns "sent" instead of deleting), and markTaskDocCommentsSent
//     only flips rows that are still unsent, so re-sending is a no-op count.
//   - the anchor is the FILE's git blob sha (stamped by the caller from the
//     file route's `sha`), not the worktree HEAD — this file only checks that
//     the value round-trips (blobSha itself is pinned in tests/collab.test.ts).
import { describe, it, expect } from "vitest";
import {
  createProject, createTask, deleteTask,
  listTaskDocComments, addTaskDocComment, markTaskDocCommentsSent, deleteTaskDocComment,
} from "@/lib/store";
import { GET, POST } from "@/app/api/tasks/[id]/doc-comments/route";
import { POST as markSent } from "@/app/api/tasks/[id]/doc-comments/sent/route";
import { DELETE as deleteComment } from "@/app/api/tasks/[id]/doc-comments/[cid]/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const cidParams = (id: string, cid: string) => ({ params: Promise.resolve({ id, cid }) });
const SHA_A = "a".repeat(40);

function makeTask() {
  const project = createProject({ name: `DocComments ${Math.random()}` });
  return createTask({ project_id: project.id, title: "Write docs" });
}

describe("store: task_doc_comments", () => {
  it("add → list, ordered by creation", () => {
    const task = makeTask();
    const c1 = addTaskDocComment(task.id, "docs/a.md", "quote one", "Heading", "first", SHA_A);
    const c2 = addTaskDocComment(task.id, "docs/a.md", "quote two", null, "second", null);
    const rows = listTaskDocComments(task.id);
    expect(rows.map((r) => r.id)).toEqual([c1.id, c2.id]);
    expect(rows[0]).toMatchObject({ file: "docs/a.md", quote: "quote one", heading: "Heading", body: "first", sent_to_agent: 0, anchor_sha: SHA_A });
    expect(rows[1]).toMatchObject({ heading: null, anchor_sha: null });
  });

  it("filters by file", () => {
    const task = makeTask();
    addTaskDocComment(task.id, "docs/a.md", "in a", null, "body", null);
    addTaskDocComment(task.id, "docs/other.md", "in other", null, "body", null);
    expect(listTaskDocComments(task.id, "docs/other.md")).toHaveLength(1);
    expect(listTaskDocComments(task.id, "docs/other.md")[0].file).toBe("docs/other.md");
    expect(listTaskDocComments(task.id)).toHaveLength(2);
  });

  it("markTaskDocCommentsSent counts flipped rows, skips another task's id, and is a no-op the second time", () => {
    const task = makeTask();
    const other = makeTask();
    const mine = addTaskDocComment(task.id, "docs/a.md", "q", null, "b", null);
    const theirs = addTaskDocComment(other.id, "docs/a.md", "q", null, "b", null);

    const flipped = markTaskDocCommentsSent(task.id, [mine.id, theirs.id]);
    expect(flipped).toBe(1); // theirs is skipped — it belongs to another task
    expect(listTaskDocComments(task.id)[0].sent_to_agent).toBe(1);
    expect(listTaskDocComments(other.id)[0].sent_to_agent).toBe(0); // untouched

    // Calling again with the same ids changes nothing — already sent.
    expect(markTaskDocCommentsSent(task.id, [mine.id, theirs.id])).toBe(0);
  });

  it("deleteTaskDocComment: missing, sent (refused), then deleted", () => {
    const task = makeTask();
    expect(deleteTaskDocComment(task.id, "nope")).toBe("missing");

    const sent = addTaskDocComment(task.id, "docs/a.md", "q", null, "b", null);
    markTaskDocCommentsSent(task.id, [sent.id]);
    expect(deleteTaskDocComment(task.id, sent.id)).toBe("sent");
    expect(listTaskDocComments(task.id)).toHaveLength(1); // not removed

    const draft = addTaskDocComment(task.id, "docs/a.md", "q2", null, "b2", null);
    expect(deleteTaskDocComment(task.id, draft.id)).toBe("deleted");
    expect(deleteTaskDocComment(task.id, draft.id)).toBe("missing"); // gone now
  });

  it("cascades away when the task is deleted", () => {
    const task = makeTask();
    addTaskDocComment(task.id, "docs/a.md", "q", null, "b", null);
    expect(listTaskDocComments(task.id)).toHaveLength(1);
    deleteTask(task.id);
    expect(listTaskDocComments(task.id)).toHaveLength(0);
  });
});

describe("routes: /api/tasks/[id]/doc-comments", () => {
  it("404 on an unknown task across all four handlers", async () => {
    const bad = "nonexistent-task-id";
    expect((await GET(new Request(`http://x/api/tasks/${bad}/doc-comments`), params(bad))).status).toBe(404);
    expect(
      (
        await POST(
          new Request(`http://x/api/tasks/${bad}/doc-comments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: "a.md", quote: "q", body: "b" }),
          }),
          params(bad)
        )
      ).status
    ).toBe(404);
    expect(
      (
        await markSent(
          new Request(`http://x/api/tasks/${bad}/doc-comments/sent`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: [] }),
          }),
          params(bad)
        )
      ).status
    ).toBe(404);
    expect(
      (await deleteComment(new Request(`http://x/api/tasks/${bad}/doc-comments/c1`, { method: "DELETE" }), cidParams(bad, "c1"))).status
    ).toBe(404);
  });

  it("POST 400s when quote is missing", async () => {
    const task = makeTask();
    const res = await POST(
      new Request(`http://x/api/tasks/${task.id}/doc-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "docs/a.md", body: "no quote here" }),
      }),
      params(task.id)
    );
    expect(res.status).toBe(400);
  });

  it("POST 201s, trims fields, nulls an empty heading and a non-sha anchor, keeps a real 40-hex sha", async () => {
    const task = makeTask();
    const res = await POST(
      new Request(`http://x/api/tasks/${task.id}/doc-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: " docs/a.md ", quote: "  the quote  ", heading: "  ", body: "  the note  ", anchorSha: "not-a-sha" }),
      }),
      params(task.id)
    );
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.ok).toBe(true);
    // file isn't in the "trimmed" contract explicitly, but quote/body/heading are.
    expect(j.comment.quote).toBe("the quote");
    expect(j.comment.body).toBe("the note");
    expect(j.comment.heading).toBeNull(); // "" after trim → null
    expect(j.comment.anchor_sha).toBeNull(); // not 40 lowercase hex → dropped
    expect(j.comment.sent_to_agent).toBe(0);

    const res2 = await POST(
      new Request(`http://x/api/tasks/${task.id}/doc-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "docs/a.md", quote: "q2", heading: "Section", body: "b2", anchorSha: SHA_A }),
      }),
      params(task.id)
    );
    const j2 = await res2.json();
    expect(j2.comment.anchor_sha).toBe(SHA_A);
    expect(j2.comment.heading).toBe("Section");
  });

  it("GET filters by ?file=", async () => {
    const task = makeTask();
    addTaskDocComment(task.id, "docs/a.md", "in a", null, "b", null);
    addTaskDocComment(task.id, "docs/b.md", "in b", null, "b", null);

    const all = await GET(new Request(`http://x/api/tasks/${task.id}/doc-comments`), params(task.id));
    expect((await all.json()).comments).toHaveLength(2);

    const filtered = await GET(new Request(`http://x/api/tasks/${task.id}/doc-comments?file=docs/a.md`), params(task.id));
    const fj = await filtered.json();
    expect(fj.comments).toHaveLength(1);
    expect(fj.comments[0].file).toBe("docs/a.md");
  });

  it("sent POST 400s on a non-array ids and returns the flipped count otherwise", async () => {
    const task = makeTask();
    const bad = await markSent(
      new Request(`http://x/api/tasks/${task.id}/doc-comments/sent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: "x" }),
      }),
      params(task.id)
    );
    expect(bad.status).toBe(400);

    const c1 = addTaskDocComment(task.id, "docs/a.md", "q1", null, "b1", null);
    const c2 = addTaskDocComment(task.id, "docs/a.md", "q2", null, "b2", null);
    const ok = await markSent(
      new Request(`http://x/api/tasks/${task.id}/doc-comments/sent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [c1.id, c2.id, "unknown-id"] }),
      }),
      params(task.id)
    );
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j).toEqual({ ok: true, updated: 2 });
  });

  it("DELETE: 409 on a sent comment, 200 on a draft, then 404", async () => {
    const task = makeTask();
    const sent = addTaskDocComment(task.id, "docs/a.md", "q", null, "b", null);
    markTaskDocCommentsSent(task.id, [sent.id]);
    const refused = await deleteComment(new Request(`http://x/api/tasks/${task.id}/doc-comments/${sent.id}`, { method: "DELETE" }), cidParams(task.id, sent.id));
    expect(refused.status).toBe(409);

    const draft = addTaskDocComment(task.id, "docs/a.md", "q2", null, "b2", null);
    const ok = await deleteComment(new Request(`http://x/api/tasks/${task.id}/doc-comments/${draft.id}`, { method: "DELETE" }), cidParams(task.id, draft.id));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });

    const gone = await deleteComment(new Request(`http://x/api/tasks/${task.id}/doc-comments/${draft.id}`, { method: "DELETE" }), cidParams(task.id, draft.id));
    expect(gone.status).toBe(404);
  });
});
