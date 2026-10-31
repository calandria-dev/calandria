import { describe, expect, it } from "vitest";
import { extensionOf, imageSource, isFileLink, localLinkTarget, rawFileUrl } from "../lib/localLink";

const WT = "/home/u/.calandria/worktrees/abc";
const REPO = "/home/u/repos/proj";
const ROOTS = [WT, REPO];

describe("localLinkTarget", () => {
  it("opens a relative text link in the collaboration modal", () => {
    expect(localLinkTarget("docs/guide.md", ROOTS)).toEqual({ rel: "docs/guide.md", open: "collab" });
    expect(localLinkTarget("./README.md", ROOTS)).toEqual({ rel: "README.md", open: "collab" });
    expect(localLinkTarget("lib/a.ts", ROOTS)).toEqual({ rel: "lib/a.ts", open: "collab" });
  });

  it("re-roots an absolute path against the worktree, then the repo", () => {
    expect(localLinkTarget(`${WT}/lib/a.ts`, ROOTS)).toEqual({ rel: "lib/a.ts", open: "collab" });
    expect(localLinkTarget(`${REPO}/lib/a.ts`, ROOTS)).toEqual({ rel: "lib/a.ts", open: "collab" });
    expect(localLinkTarget("/etc/hosts", ROOTS)).toBeNull();
    expect(localLinkTarget(`${WT}-other/x.md`, ROOTS)).toBeNull();
    expect(localLinkTarget(`${WT}/lib/a.ts`, [])).toBeNull();
    expect(localLinkTarget(`${WT}/lib/a.ts`, ["", WT])).toEqual({ rel: "lib/a.ts", open: "collab" });
  });

  it("accepts file: URLs and Windows drive paths", () => {
    expect(localLinkTarget(`file://${WT}/docs/x.md`, ROOTS)).toEqual({ rel: "docs/x.md", open: "collab" });
    expect(localLinkTarget(`file://localhost${WT}/docs/x.md`, ROOTS)).toEqual({ rel: "docs/x.md", open: "collab" });
    expect(localLinkTarget(`file:${WT}/docs/x.md`, ROOTS)).toEqual({ rel: "docs/x.md", open: "collab" });
    const win = ["C:\\wt\\t1"];
    expect(localLinkTarget("C:\\wt\\t1\\docs\\x.md", win)).toEqual({ rel: "docs/x.md", open: "collab" });
    expect(localLinkTarget("file:///C:/wt/t1/docs/x.md", win)).toEqual({ rel: "docs/x.md", open: "collab" });
    expect(localLinkTarget("D:\\elsewhere\\x.md", win)).toBeNull();
  });

  it("leaves web links, anchors and protocol-relative URLs alone", () => {
    expect(localLinkTarget("https://example.com/docs/x.md", ROOTS)).toBeNull();
    expect(localLinkTarget("http://host:8080/", ROOTS)).toBeNull();
    expect(localLinkTarget("mailto:a@b.c", ROOTS)).toBeNull();
    expect(localLinkTarget("#heading", ROOTS)).toBeNull();
    expect(localLinkTarget("//cdn.example.com/x.png", ROOTS)).toBeNull();
    expect(localLinkTarget("", ROOTS)).toBeNull();
    expect(localLinkTarget("javascript:alert(1)", ROOTS)).toBeNull();
  });

  it("strips location citations, fragments, queries and percent-encoding", () => {
    expect(localLinkTarget("lib/a.ts:42", ROOTS)).toEqual({ rel: "lib/a.ts", open: "collab" });
    expect(localLinkTarget("lib/a.ts:42:7", ROOTS)).toEqual({ rel: "lib/a.ts", open: "collab" });
    expect(localLinkTarget("README.md:3", ROOTS)).toEqual({ rel: "README.md", open: "collab" });
    expect(localLinkTarget("lib/a.ts#L42", ROOTS)).toEqual({ rel: "lib/a.ts", open: "collab" });
    expect(localLinkTarget("docs/x.md?v=2#top", ROOTS)).toEqual({ rel: "docs/x.md", open: "collab" });
    expect(localLinkTarget("docs/my%20notes.md", ROOTS)).toEqual({ rel: "docs/my notes.md", open: "collab" });
    expect(localLinkTarget(`${WT}/docs/my%20notes.md`, ROOTS)).toEqual({ rel: "docs/my notes.md", open: "collab" });
  });

  it("resolves a relative link against the document's directory", () => {
    expect(localLinkTarget("setup.md", ROOTS, "docs")).toEqual({ rel: "docs/setup.md", open: "collab" });
    expect(localLinkTarget("../README.md", ROOTS, "docs/guides")).toEqual({ rel: "docs/README.md", open: "collab" });
    expect(localLinkTarget("../../README.md", ROOTS, "docs/guides")).toEqual({ rel: "README.md", open: "collab" });
    expect(localLinkTarget("../../../etc/passwd", ROOTS, "docs/guides")).toBeNull();
    expect(localLinkTarget("../x.md", ROOTS)).toBeNull();
    expect(localLinkTarget(".", ROOTS)).toBeNull();
  });

  it("sends images and known binaries to the raw route, everything else to the modal", () => {
    expect(localLinkTarget("shots/a.png", ROOTS)).toEqual({ rel: "shots/a.png", open: "raw" });
    expect(localLinkTarget("shots/A.JPG", ROOTS)).toEqual({ rel: "shots/A.JPG", open: "raw" });
    expect(localLinkTarget("dist/app.zip", ROOTS)).toEqual({ rel: "dist/app.zip", open: "raw" });
    expect(localLinkTarget("paper.pdf", ROOTS)).toEqual({ rel: "paper.pdf", open: "raw" });
    expect(localLinkTarget("Dockerfile", ROOTS)).toEqual({ rel: "Dockerfile", open: "collab" });
    expect(localLinkTarget(".gitignore", ROOTS)).toEqual({ rel: ".gitignore", open: "collab" });
    expect(localLinkTarget("infra/main.tf", ROOTS)).toEqual({ rel: "infra/main.tf", open: "collab" });
    expect(localLinkTarget("config.yaml", ROOTS)).toEqual({ rel: "config.yaml", open: "collab" });
    expect(localLinkTarget("data.json", ROOTS)).toEqual({ rel: "data.json", open: "collab" });
    expect(localLinkTarget("logo.svg", ROOTS)).toEqual({ rel: "logo.svg", open: "collab" });
  });
});

describe("isFileLink", () => {
  it("names the hrefs react-markdown's default filter would blank", () => {
    expect(isFileLink("file:///home/u/x.md")).toBe(true);
    expect(isFileLink("C:\\wt\\x.md")).toBe(true);
    expect(isFileLink("c:/wt/x.md")).toBe(true);
    expect(isFileLink("README.md:3")).toBe(true);
    expect(isFileLink("lib/a.ts:42:7")).toBe(true);
    expect(isFileLink("javascript:1")).toBe(false);
    expect(isFileLink("javascript:alert(1)")).toBe(false);
    expect(isFileLink("https://example.com")).toBe(false);
    expect(isFileLink("docs/x.md")).toBe(false);
  });
});

describe("extensionOf / rawFileUrl", () => {
  it("reads the last segment's extension, lowercased, and not a leading dot", () => {
    expect(extensionOf("shots/A.PNG")).toBe("png");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("Dockerfile")).toBe("");
    expect(extensionOf("a.b/Makefile")).toBe("");
    expect(extensionOf("x.tar.gz")).toBe("gz");
  });
  it("encodes the task id and path", () => {
    expect(rawFileUrl("t1", "shots/my pic.png")).toBe("/api/tasks/t1/file/raw?path=shots%2Fmy%20pic.png");
  });
});

describe("imageSource", () => {
  const LINKS = { taskId: "t1", roots: ROOTS };
  const raw = (rel: string) => rawFileUrl("t1", rel);

  it("serves a relative worktree image from the raw route", () => {
    const rel = "projects/panel-controls/button-module/build/checks/button-module-back.png";
    expect(imageSource(rel, LINKS)).toEqual({ kind: "local", src: raw(rel), rel });
  });
  it("re-roots an absolute path inside the worktree or the repo", () => {
    expect(imageSource(`${WT}/build/a.png`, LINKS)).toEqual({ kind: "local", src: raw("build/a.png"), rel: "build/a.png" });
    expect(imageSource(`${REPO}/shots/b.jpg`, LINKS)).toEqual({ kind: "local", src: raw("shots/b.jpg"), rel: "shots/b.jpg" });
    expect(imageSource(`file://${WT}/c.webp`, LINKS)).toEqual({ kind: "local", src: raw("c.webp"), rel: "c.webp" });
  });
  it("resolves against the document's directory", () => {
    expect(imageSource("../img/d.gif", { ...LINKS, baseDir: "docs/guide" })).toEqual({ kind: "local", src: raw("docs/img/d.gif"), rel: "docs/img/d.gif" });
  });
  it("blocks a path that escapes the worktree", () => {
    expect(imageSource("../secret.png", LINKS)).toEqual({ kind: "blocked" });
    expect(imageSource("docs/../../secret.png", LINKS)).toEqual({ kind: "blocked" });
    expect(imageSource("/etc/secret.png", LINKS)).toEqual({ kind: "blocked" });
    expect(imageSource(`${WT}-other/a.png`, LINKS)).toEqual({ kind: "blocked" });
    expect(imageSource("//evil.example/a.png", LINKS)).toEqual({ kind: "blocked" });
  });
  it("blocks a file that is not an image and an unknown scheme", () => {
    expect(imageSource("docs/guide.md", LINKS)).toEqual({ kind: "blocked" });
    expect(imageSource("javascript:alert(1)", LINKS)).toEqual({ kind: "blocked" });
    expect(imageSource("", LINKS)).toEqual({ kind: "blocked" });
  });
  it("leaves web and inline images alone", () => {
    expect(imageSource("https://example.com/a.png", LINKS)).toEqual({ kind: "remote", src: "https://example.com/a.png" });
    expect(imageSource("data:image/png;base64,AAAA", LINKS)).toEqual({ kind: "remote", src: "data:image/png;base64,AAAA" });
    expect(imageSource("http://example.com/a.png")).toEqual({ kind: "remote", src: "http://example.com/a.png" });
  });
  it("blocks every local path without a task to serve it", () => {
    expect(imageSource("shots/a.png")).toEqual({ kind: "blocked" });
    expect(imageSource(`${WT}/shots/a.png`)).toEqual({ kind: "blocked" });
  });
});
