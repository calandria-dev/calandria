import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProject, createTask } from "@/lib/store";
import { MAX_UPLOAD_BYTES, taskUploadsDir } from "@/lib/uploads";
import {
  displayFileName,
  isImageExt,
  parseStagedFile,
  safeStem,
  servedType,
  stagedFileName,
  uploadExtension,
} from "@/lib/uploadTypes";
import { POST } from "@/app/api/tasks/[id]/uploads/route";
import { GET } from "@/app/api/tasks/[id]/uploads/[file]/route";

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
  // The bug this whole feature is: file.type is an OS-registry lookup, so it is
  // routinely blank for exactly the formats a user wants to hand over.
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
    // Every dot is stripped from the stem, so a staged name holds exactly one —
    // which is what lets the serving route's guard be a plain charset test.
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
    // Markup is deliberately text/plain rather than its real type: with nosniff
    // it renders as source instead of executing on this origin.
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
