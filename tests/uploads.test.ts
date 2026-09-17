import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProject, createTask, listTasks } from "@/lib/store";
import { MAX_UPLOAD_BYTES, draftUploadsDir, sweepStaleDrafts, taskUploadsDir } from "@/lib/uploads";
import {
  attachmentMarker,
  displayFileName,
  fileAttachmentMarker,
  hasAttachmentMarkers,
  isImageExt,
  joinAttachmentText,
  markerFor,
  parseStagedFile,
  safeStem,
  servedType,
  splitAttachmentText,
  stagedFileName,
  uploadExtension,
} from "@/lib/uploadTypes";
import { POST } from "@/app/api/tasks/[id]/uploads/route";
import { GET, DELETE as deleteTaskUploadFile } from "@/app/api/tasks/[id]/uploads/[file]/route";
import { POST as uploadDraft } from "@/app/api/uploads/route";
import { DELETE as deleteDraft } from "@/app/api/uploads/[draft]/route";
import { POST as createTaskRoute } from "@/app/api/tasks/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const fileParams = (id: string, file: string) => ({ params: Promise.resolve({ id, file }) });

function task() {
  const project = createProject({ name: `up-${Math.random().toString(36).slice(2)}` });
  return createTask({ project_id: project.id, title: "attachments" }).id;
}

/** A real multipart POST, the way the composer sends one. */
async function upload(taskId: string, name: string, type: string, body = "hello") {
  const form = new FormData();
  form.append("file", new File([body], name, { type }), name);
  const res = await POST(new Request("http://local/upload", { method: "POST", body: form }), params(taskId));
  return { res, json: (await res.json()) as { path?: string; url?: string; name?: string; error?: string } };
}

describe("attachment typing", () => {
  // file.type is an OS-registry lookup, so it is routinely blank for exactly
  // the formats a user wants to hand over.
  it("takes the extension from the filename, not the MIME type", () => {
    expect(uploadExtension("q3-report.pdf", "")).toBe("pdf");
    expect(uploadExtension("server.log", "")).toBe("log");
    expect(uploadExtension("notes.MD", "application/octet-stream")).toBe("md");
    expect(uploadExtension("bundle.tar.gz", "")).toBe("gz");
  });

  it("falls back to the MIME type when the name has no usable extension", () => {
    // A clipboard screenshot: real MIME, blank name.
    expect(uploadExtension("", "image/png")).toBe("png");
    expect(uploadExtension("image.png", "")).toBe("png");
    expect(uploadExtension("pasted", "text/plain;charset=utf-8")).toBe("txt");
    expect(uploadExtension("Makefile", "")).toBe("bin");
    expect(uploadExtension("weird.this-is-not-an-extension", "")).toBe("bin");
  });

  it("stages under a name that cannot escape the uploads dir", () => {
    // Every dot is stripped from the stem, so a staged name holds exactly one,
    // which lets the serving route's guard be a plain charset test.
    expect(safeStem("../../etc/passwd")).toBe("passwd");
    expect(safeStem("my.config.yaml")).toBe("my-config");
    expect(safeStem("report (final) v2.pdf")).toBe("report-final-v2");
    expect(safeStem("...")).toBe("file");
    expect(safeStem("")).toBe("file");
    expect(safeStem("x".repeat(200) + ".txt")).toHaveLength(48);

    const staged = stagedFileName("u".repeat(21), "../../etc/passwd", "");
    expect(staged).not.toContain("..");
    expect(staged).not.toContain("/");
    expect(parseStagedFile(staged)).toEqual({ ext: "bin" });
  });

  it("rejects a filename it did not generate", () => {
    expect(parseStagedFile("../secret.txt")).toBeNull();
    expect(parseStagedFile("a/b.txt")).toBeNull();
    expect(parseStagedFile("two.dots.txt")).toBeNull();
    expect(parseStagedFile("noext")).toBeNull();
    expect(parseStagedFile("x.TXT")).toBeNull();
    expect(parseStagedFile(`x.${"e".repeat(13)}`)).toBeNull();
    // Names staged before filenames were preserved still resolve.
    expect(parseStagedFile("V1StGXR8_Z5jdHi6B-myT.png")).toEqual({ ext: "png" });
  });

  it("serves images inline, known text as text, and everything else as a download", () => {
    expect(servedType("png")).toEqual({ contentType: "image/png", download: false });
    expect(servedType("jpeg")).toEqual({ contentType: "image/jpeg", download: false });
    expect(servedType("md").contentType).toBe("text/plain; charset=utf-8");
    // Markup is served as text/plain, not its real type: with nosniff it
    // renders as source instead of executing on this origin.
    expect(servedType("html")).toEqual({ contentType: "text/plain; charset=utf-8", download: false });
    expect(servedType("svg")).toEqual({ contentType: "text/plain; charset=utf-8", download: false });
    expect(servedType("pdf")).toEqual({ contentType: "application/octet-stream", download: true });
    expect(servedType("zip")).toEqual({ contentType: "application/octet-stream", download: true });
    expect(isImageExt("webp")).toBe(true);
    expect(isImageExt("pdf")).toBe(false);
  });

  it("shows the user's own filename back", () => {
    expect(displayFileName(stagedFileName("u".repeat(21), "q3-report.pdf", ""))).toBe("q3-report.pdf");
    // Legacy `<nanoid>.<ext>` names have no prefix to strip.
    expect(displayFileName("V1StGXR8_Z5jdHi6B-myT.png")).toBe("V1StGXR8_Z5jdHi6B-myT.png");
  });
});

describe("POST /api/tasks/[id]/uploads", () => {
  it("accepts any file type and stages it outside the worktree", async () => {
    const id = task();
    const { res, json } = await upload(id, "q3-report.pdf", "application/pdf");

    expect(res.status).toBe(200);
    expect(path.dirname(json.path!)).toBe(taskUploadsDir(id));
    // The user's name survives, because it is the agent's only clue to the
    // format when it reads the staged path out of the message.
    expect(path.basename(json.path!)).toMatch(/-q3-report\.pdf$/);
    expect(fs.readFileSync(json.path!, "utf8")).toBe("hello");
    expect(json.url).toBe(`/api/tasks/${id}/uploads/${path.basename(json.path!)}`);
  });

  it("stages a file whose MIME the browser did not fill in", async () => {
    const id = task();
    const { res, json } = await upload(id, "server.log", "");
    expect(res.status).toBe(200);
    expect(path.basename(json.path!)).toMatch(/-server\.log$/);
  });

  it("404s for a task that does not exist", async () => {
    const { res } = await upload("nope", "a.txt", "text/plain");
    expect(res.status).toBe(404);
  });

  it("rejects an oversized body on the declared length, before buffering it", async () => {
    const id = task();
    let parsed = false;
    const req = {
      headers: new Headers({ "content-length": String(MAX_UPLOAD_BYTES + 5000) }),
      formData: async () => { parsed = true; return new FormData(); },
    } as unknown as Request;

    const res = await POST(req, params(id));

    expect(res.status).toBe(413);
    expect(parsed).toBe(false);
    expect(fs.existsSync(taskUploadsDir(id))).toBe(false);
  });

  it("rejects an oversized file whose declared length lied", async () => {
    const id = task();
    const oversized = { name: "huge.zip", type: "", size: MAX_UPLOAD_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) };
    const req = {
      headers: new Headers({ "content-length": "10" }),
      formData: async () => ({ get: () => oversized }),
    } as unknown as Request;

    const res = await POST(req, params(id));

    expect(res.status).toBe(413);
    expect(fs.existsSync(taskUploadsDir(id))).toBe(false);
  });
});

describe("GET /api/tasks/[id]/uploads/[file]", () => {
  it("hands an unknown type back as an opaque, non-sniffable download", async () => {
    const id = task();
    const { json } = await upload(id, "archive.zip", "application/zip");
    const file = path.basename(json.path!);

    const res = await GET(new Request("http://local/f"), fileParams(id, file));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.text()).toBe("hello");
  });

  it("previews text and images inline", async () => {
    const id = task();
    const text = await upload(id, "notes.md", "");
    const textRes = await GET(new Request("http://local/f"), fileParams(id, path.basename(text.json.path!)));
    expect(textRes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(textRes.headers.get("content-disposition")).toBeNull();

    const img = await upload(id, "shot.png", "image/png");
    const imgRes = await GET(new Request("http://local/f"), fileParams(id, path.basename(img.json.path!)));
    expect(imgRes.headers.get("content-type")).toBe("image/png");
    expect(imgRes.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses to walk out of the task's uploads dir", async () => {
    const id = task();
    fs.mkdirSync(taskUploadsDir(id), { recursive: true });
    for (const file of ["../../calandria.db", "..%2Fsecret.txt", "a/b.txt", "secret"]) {
      const res = await GET(new Request("http://local/f"), fileParams(id, file));
      expect(res.status).toBe(404);
    }
    expect((await GET(new Request("http://local/f"), fileParams("../..", "a.txt"))).status).toBe(404);
  });
});

describe("DELETE /api/tasks/[id]/uploads/[file]", () => {
  it("removes an attachment and is idempotent", async () => {
    const id = task();
    const { json } = await upload(id, "notes.md", "");
    const file = path.basename(json.path!);

    const res1 = await deleteTaskUploadFile(new Request("http://local/f", { method: "DELETE" }), fileParams(id, file));
    expect(await res1.json()).toEqual({ ok: true, removed: true });
    expect(fs.existsSync(json.path!)).toBe(false);

    // A second call finds nothing to remove but still answers ok.
    const res2 = await deleteTaskUploadFile(new Request("http://local/f", { method: "DELETE" }), fileParams(id, file));
    expect(await res2.json()).toEqual({ ok: true, removed: false });
  });
});

describe("attachment markers (lib/uploadTypes.ts)", () => {
  it("strips only marker lines pointing at a staged uploads/<task>/<file> path", () => {
    const id = task();
    const staged = path.join(taskUploadsDir(id), "abc123-notes.pdf");
    const content = `Please review this.\n\n${fileAttachmentMarker(staged)}`;

    const { text, attachments } = splitAttachmentText(content);

    expect(text).toBe("Please review this.");
    expect(attachments).toEqual([{ kind: "file", path: staged, taskId: id, file: "abc123-notes.pdf" }]);
  });

  it("leaves a hand-typed lookalike marker in the prose untouched", () => {
    // Not staged by us: too short a path to end in uploads/<task>/<file>.
    const content = "Notes:\n[Attached file: /tmp/x.txt]";
    const { text, attachments } = splitAttachmentText(content);
    expect(attachments).toEqual([]);
    expect(text).toBe(content);
  });

  it("joins prose then one marker per attachment, and round-trips through split", () => {
    const id = task();
    const dir = taskUploadsDir(id);
    const attachments = [
      { kind: "image" as const, path: path.join(dir, "u1-shot.png") },
      { kind: "file" as const, path: path.join(dir, "u2-report.pdf") },
    ];

    const joined = joinAttachmentText("Fix the header.", attachments);

    expect(joined).toBe(
      `Fix the header.\n\n${attachmentMarker(attachments[0].path)}\n\n${fileAttachmentMarker(attachments[1].path)}`
    );
    const { text, attachments: parsed } = splitAttachmentText(joined);
    expect(text).toBe("Fix the header.");
    expect(parsed.map((a) => ({ kind: a.kind, path: a.path }))).toEqual(attachments);
  });

  it("markerFor picks image for an image extension and file for anything else", () => {
    const id = task();
    const dir = taskUploadsDir(id);
    const png = path.join(dir, "x.png");
    const pdf = path.join(dir, "x.pdf");
    expect(markerFor(png)).toBe(attachmentMarker(png));
    expect(markerFor(pdf)).toBe(fileAttachmentMarker(pdf));
  });

  it("hasAttachmentMarkers detects either marker kind and nothing else", () => {
    expect(hasAttachmentMarkers("plain text, no markers here")).toBe(false);
    expect(hasAttachmentMarkers(fileAttachmentMarker("/a/uploads/t/x.txt"))).toBe(true);
    expect(hasAttachmentMarkers(attachmentMarker("/a/uploads/t/x.png"))).toBe(true);
  });
});

describe("POST /api/uploads (draft staging)", () => {
  async function stageDraft(name: string, type: string, draft?: string, body = "hi") {
    const form = new FormData();
    form.append("file", new File([body], name, { type }), name);
    if (draft !== undefined) form.append("draft", draft);
    const res = await uploadDraft(new Request("http://local/upload", { method: "POST", body: form }));
    const json = (await res.json()) as { ok?: boolean; path?: string; name?: string; draft?: string; error?: string };
    return { res, json };
  }

  it("stages under DRAFTS_DIR/<draft>/ and mints a fresh draft id when none is given", async () => {
    const { res, json } = await stageDraft("notes.md", "");
    expect(res.status).toBe(200);
    expect(json.draft).toBeTruthy();
    expect(path.dirname(json.path!)).toBe(draftUploadsDir(json.draft!));
    expect(fs.readFileSync(json.path!, "utf8")).toBe("hi");
  });

  it("honors a safe caller-supplied draft id", async () => {
    const { json } = await stageDraft("notes.md", "", "my-draft-1");
    expect(json.draft).toBe("my-draft-1");
    expect(path.dirname(json.path!)).toBe(draftUploadsDir("my-draft-1"));
  });

  it("replaces an unsafe draft id (path traversal) with a minted one", async () => {
    const { json } = await stageDraft("notes.md", "", "../../etc/passwd");
    expect(json.draft).not.toBe("../../etc/passwd");
    expect(json.draft).not.toContain("..");
    expect(json.draft).not.toContain("/");
    expect(path.dirname(json.path!)).toBe(draftUploadsDir(json.draft!));
  });

  it("413s on a declared length over the cap, before touching formData", async () => {
    let parsed = false;
    const req = {
      headers: new Headers({ "content-length": String(MAX_UPLOAD_BYTES + 5000) }),
      formData: async () => {
        parsed = true;
        return new FormData();
      },
    } as unknown as Request;

    const res = await uploadDraft(req);

    expect(res.status).toBe(413);
    expect(parsed).toBe(false);
  });

  it("400s on a non-multipart body", async () => {
    const req = new Request("http://local/upload", {
      method: "POST",
      body: "not multipart",
      headers: { "content-length": "13" },
    });
    const res = await uploadDraft(req);
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/uploads/[draft]", () => {
  it("removes a draft's whole staged dir", async () => {
    const form = new FormData();
    form.append("file", new File(["hi"], "x.txt", { type: "" }), "x.txt");
    form.append("draft", "d-remove");
    await uploadDraft(new Request("http://local/upload", { method: "POST", body: form }));
    expect(fs.existsSync(draftUploadsDir("d-remove"))).toBe(true);

    const res = await deleteDraft(new Request("http://local/d", { method: "DELETE" }), {
      params: Promise.resolve({ draft: "d-remove" }),
    });

    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(fs.existsSync(draftUploadsDir("d-remove"))).toBe(false);
  });
});

describe("sweepStaleDrafts", () => {
  it("removes a draft dir older than maxAge and keeps a fresh one", async () => {
    const oldForm = new FormData();
    oldForm.append("file", new File(["old"], "old.txt", { type: "" }), "old.txt");
    oldForm.append("draft", "d-old");
    await uploadDraft(new Request("http://local/upload", { method: "POST", body: oldForm }));

    const freshForm = new FormData();
    freshForm.append("file", new File(["fresh"], "fresh.txt", { type: "" }), "fresh.txt");
    freshForm.append("draft", "d-fresh");
    await uploadDraft(new Request("http://local/upload", { method: "POST", body: freshForm }));

    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(draftUploadsDir("d-old"), oldTime, oldTime);

    const removed = sweepStaleDrafts(60 * 60 * 1000, Date.now());

    expect(removed).toBe(1);
    expect(fs.existsSync(draftUploadsDir("d-old"))).toBe(false);
    expect(fs.existsSync(draftUploadsDir("d-fresh"))).toBe(true);
  });
});

describe("POST /api/tasks with attachments (draft adoption)", () => {
  function project() {
    return createProject({ name: `adopt-${Math.random().toString(36).slice(2)}` });
  }

  async function stageOne(name = "notes.md", type = "") {
    const form = new FormData();
    form.append("file", new File(["hello"], name, { type }), name);
    const res = await uploadDraft(new Request("http://local/upload", { method: "POST", body: form }));
    return (await res.json()) as { path: string; draft: string };
  }

  function createTaskReq(body: unknown) {
    return createTaskRoute(
      new Request("http://local/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  }

  it("adopts staged drafts into the new task's own dir and appends marker lines", async () => {
    const proj = project();
    const staged = await stageOne("notes.md", "");

    const res = await createTaskReq({
      project_id: proj.id,
      title: "With files",
      description: "the brief",
      attachments: [staged.path],
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; description: string };
    const { text, attachments } = splitAttachmentText(created.description);
    expect(text).toBe("the brief");
    expect(attachments).toHaveLength(1);
    expect(path.dirname(attachments[0].path)).toBe(taskUploadsDir(created.id));
    expect(fs.readFileSync(attachments[0].path, "utf8")).toBe("hello");
    // The draft dir is gone: adoptDraftUploads moves the file, it doesn't copy it.
    expect(fs.existsSync(draftUploadsDir(staged.draft))).toBe(false);
  });

  it("400s and creates nothing for a path outside DRAFTS_DIR", async () => {
    const proj = project();
    const before = listTasks(proj.id).length;

    for (const bad of ["/etc/passwd", path.join(taskUploadsDir("some-other-task"), "x.txt")]) {
      const res = await createTaskReq({ project_id: proj.id, title: "Bad path", attachments: [bad] });
      expect(res.status).toBe(400);
    }

    expect(listTasks(proj.id)).toHaveLength(before);
  });

  it("400s when attachments isn't an array of strings", async () => {
    const proj = project();
    for (const bad of ["not-an-array", [123], [null]]) {
      const res = await createTaskReq({ project_id: proj.id, title: "Bad shape", attachments: bad });
      expect(res.status).toBe(400);
    }
  });
});
