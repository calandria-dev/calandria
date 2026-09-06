// Document collaboration drafts (task_doc_drafts) are the modal-local halves
// of a review: one row per (task, file) holding the Edit tab's text and the
// General comments note, TaskDocComment's sibling for the parts that aren't
// per-passage. Two things are pinned that a naive upsert wouldn't get right:
//   - an empty draft (no edit, blank note) is DELETED rather than stored, so
//     the row's presence itself means "there is something to restore".
//   - PUT is a full replace, not a merge: a second put with text: null clears
//     a previous edit rather than leaving it in place.
import { describe, it, expect } from "vitest";
import {
  createProject, createTask, deleteTask,
  getTaskDocDraft, putTaskDocDraft, deleteTaskDocDraft,
} from "@/lib/store";
import { GET, PUT, DELETE } from "@/app/api/tasks/[id]/doc-draft/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const SHA_A = "a".repeat(40);

function makeTask() {
  const project = createProject({ name: `DocDrafts ${Math.random()}` });
  return createTask({ project_id: project.id, title: "Write docs" });
}

describe("store: task_doc_drafts", () => {
  it("put → get round-trips text, general and anchor; a second put replaces", () => {
    const task = makeTask();
    putTaskDocDraft(task.id, "docs/a.md", { text: "edited", general: "note", anchorSha: SHA_A });
    const got = getTaskDocDraft(task.id, "docs/a.md");
    expect(got).toMatchObject({ task_id: task.id, file: "docs/a.md", text: "edited", general: "note", anchor_sha: SHA_A });
    expect(typeof got?.updated_at).toBe("number");

    putTaskDocDraft(task.id, "docs/a.md", { text: null, general: "note 2", anchorSha: null });
    const got2 = getTaskDocDraft(task.id, "docs/a.md");
    expect(got2).toMatchObject({ text: null, general: "note 2", anchor_sha: null });
  });

  it("an empty put deletes the row and returns null", () => {
    const task = makeTask();
    putTaskDocDraft(task.id, "docs/a.md", { text: "edited", general: "note", anchorSha: null });
    expect(getTaskDocDraft(task.id, "docs/a.md")).not.toBeNull();

    const result = putTaskDocDraft(task.id, "docs/a.md", { text: null, general: "  ", anchorSha: null });
    expect(result).toBeNull();
    expect(getTaskDocDraft(task.id, "docs/a.md")).toBeNull();
  });

  it("one row per (task, file): two files don't collide", () => {
    const task = makeTask();
    putTaskDocDraft(task.id, "docs/a.md", { text: "a", general: "", anchorSha: null });
    putTaskDocDraft(task.id, "docs/b.md", { text: "b", general: "", anchorSha: null });
    expect(getTaskDocDraft(task.id, "docs/a.md")?.text).toBe("a");
    expect(getTaskDocDraft(task.id, "docs/b.md")?.text).toBe("b");
  });

  it("deleteTaskDocDraft reports whether a row went", () => {
    const task = makeTask();
    putTaskDocDraft(task.id, "docs/a.md", { text: "a", general: "", anchorSha: null });
    expect(deleteTaskDocDraft(task.id, "docs/a.md")).toBe(true);
    expect(deleteTaskDocDraft(task.id, "docs/a.md")).toBe(false);
  });

  it("cascades away when the task is deleted", () => {
    const task = makeTask();
    putTaskDocDraft(task.id, "docs/a.md", { text: "a", general: "", anchorSha: null });
    expect(getTaskDocDraft(task.id, "docs/a.md")).not.toBeNull();
    deleteTask(task.id);
    expect(getTaskDocDraft(task.id, "docs/a.md")).toBeNull();
  });
});

describe("routes: /api/tasks/[id]/doc-draft", () => {
  it("404 on an unknown task across all three handlers", async () => {
    const bad = "nonexistent-task-id";
    expect((await GET(new Request(`http://x/api/tasks/${bad}/doc-draft?file=a.md`), params(bad))).status).toBe(404);
    expect(
      (
        await PUT(
          new Request(`http://x/api/tasks/${bad}/doc-draft`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: "a.md", text: "x" }),
          }),
          params(bad)
        )
      ).status
    ).toBe(404);
    expect((await DELETE(new Request(`http://x/api/tasks/${bad}/doc-draft?file=a.md`, { method: "DELETE" }), params(bad))).status).toBe(404);
  });

  it("GET 400s without ?file= and returns null for a file with no draft", async () => {
    const task = makeTask();
    const missing = await GET(new Request(`http://x/api/tasks/${task.id}/doc-draft`), params(task.id));
    expect(missing.status).toBe(400);

    const empty = await GET(new Request(`http://x/api/tasks/${task.id}/doc-draft?file=docs/a.md`), params(task.id));
    expect(empty.status).toBe(200);
    expect((await empty.json()).draft).toBeNull();
  });

  it("PUT validates, keeps a 40-hex anchor, nulls a bad one, and an empty draft comes back null", async () => {
    const task = makeTask();

    const res = await PUT(
      new Request(`http://x/api/tasks/${task.id}/doc-draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "docs/a.md", text: "x", general: " g ", anchorSha: "bad" }),
      }),
      params(task.id)
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.draft.text).toBe("x");
    expect(j.draft.anchor_sha).toBeNull(); // not 40 lowercase hex, so dropped

    const res2 = await PUT(
      new Request(`http://x/api/tasks/${task.id}/doc-draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "docs/a.md", text: "x", general: "g", anchorSha: SHA_A }),
      }),
      params(task.id)
    );
    const j2 = await res2.json();
    expect(j2.draft.anchor_sha).toBe(SHA_A);

    const bad = await PUT(
      new Request(`http://x/api/tasks/${task.id}/doc-draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "docs/a.md", text: 5 }),
      }),
      params(task.id)
    );
    expect(bad.status).toBe(400);

    const emptied = await PUT(
      new Request(`http://x/api/tasks/${task.id}/doc-draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "docs/a.md", text: null, general: "" }),
      }),
      params(task.id)
    );
    expect(emptied.status).toBe(200);
    expect((await emptied.json()).draft).toBeNull();

    const gone = await GET(new Request(`http://x/api/tasks/${task.id}/doc-draft?file=docs/a.md`), params(task.id));
    expect((await gone.json()).draft).toBeNull();
  });

  it("DELETE ?file= reports deleted true then false", async () => {
    const task = makeTask();
    await PUT(
      new Request(`http://x/api/tasks/${task.id}/doc-draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "docs/a.md", text: "x" }),
      }),
      params(task.id)
    );

    const first = await DELETE(new Request(`http://x/api/tasks/${task.id}/doc-draft?file=docs/a.md`, { method: "DELETE" }), params(task.id));
    expect((await first.json()).deleted).toBe(true);

    const second = await DELETE(new Request(`http://x/api/tasks/${task.id}/doc-draft?file=docs/a.md`, { method: "DELETE" }), params(task.id));
    expect((await second.json()).deleted).toBe(false);
  });
});
