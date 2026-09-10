// Where a markdown link points when it names a file instead of a web address.
// An agent writes `[the guide](docs/guide.md)` or `[a.ts](/abs/worktree/lib/a.ts)`;
// left to the browser, both resolve against the app origin and open a 404 in
// a new tab. app/Markdown.tsx asks this module first and, for a file inside
// the task's checkout, opens it in the app instead.
//
// String-only and dependency-free: bundled for the client and unit-tested in
// Node, and both must give one answer for one link.

import { worktreeRelative } from "./collab";
import { isImageExt } from "./uploadTypes";

export type LocalLink = {
  /** Worktree-relative path of the file the link names. */
  rel: string;
  /** `collab`: text, opened in the collaboration modal. `raw`: served bytes
   *  (an image, an archive) opened by the browser in a new tab. */
  open: "collab" | "raw";
};

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DRIVE = /^[a-zA-Z]:[\\/]/;
// `lib/a.ts:42`, `README.md:3:1`: a location citation, whose colons would
// otherwise read as a URL scheme. The prefix must look like a file (a dot or
// a slash) so `javascript:1` never passes as one.
const LINE_REF = /^[^:?#]*[./][^:?#]*(:\d+)+$/;

/** True for an href that names a file, which react-markdown's default URL
 *  filter would otherwise blank: a `file:` URL, a Windows drive path, a path
 *  with a `:line` citation. Plain relative and absolute paths already pass. */
export function isFileLink(href: string): boolean {
  return /^file:/i.test(href) || DRIVE.test(href) || LINE_REF.test(href);
}

/** Extensions that never open as a document: shown or downloaded by the
 *  browser from the raw route instead. Everything else is taken as text and
 *  left to the file route's content sniff, so an extensionless `Dockerfile`
 *  or an unlisted `.tf` still opens in the modal. */
const BINARY_EXTS = new Set([
  "pdf", "zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar", "jar",
  "exe", "dll", "so", "dylib", "bin", "wasm", "o", "a", "class", "pyc",
  "woff", "woff2", "ttf", "otf", "eot", "ico", "icns", "bmp", "tif", "tiff", "avif", "heic",
  "mp3", "mp4", "m4a", "wav", "ogg", "webm", "mov", "avi", "mkv",
  "sqlite", "db", "pkl", "parquet",
]);

/** The extension of a path's last segment, lowercased, or "" for none. A
 *  leading dot is not an extension: `.gitignore` has none. */
export function extensionOf(p: string): string {
  const base = p.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Join a relative link onto the directory of the document it appears in,
 *  folding `.` and `..`. Null when `..` climbs above the worktree root. */
function joinRelative(baseDir: string, p: string): string | null {
  const out: string[] = [];
  for (const seg of `${baseDir}/${p}`.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/**
 * Resolve a link's href to a file inside the checkout, or null for anything
 * else: a web URL, an anchor, a path outside every root.
 *
 * `roots` are absolute directories an absolute path is re-rooted against, in
 * order: the task's worktree first, then the project's repo, since an agent
 * names whichever it was looking at and both hold the same tree. A relative
 * href resolves against `baseDir`, the worktree-relative directory of the
 * document it appears in ("" for a transcript message). Accepts `file:` URLs,
 * Windows drive paths, percent-encoding, and the `path:line[:col]` and
 * `#L42` forms agents use to cite a location.
 */
export function localLinkTarget(href: string, roots: string[], baseDir = ""): LocalLink | null {
  let p = href.trim();
  if (!p || p.startsWith("#") || p.startsWith("//")) return null;
  const isFile = /^file:/i.test(p);
  // Query and fragment are never part of a file name in a link, and a
  // `:line` citation is stripped before the scheme test so `README.md:3`
  // is a path and `http://host:8080/` is still a URL.
  p = p.replace(/[?#].*$/, "").replace(/(:\d+)+$/, "");
  if (!isFile && !DRIVE.test(p) && SCHEME.test(p)) return null;
  if (isFile) {
    p = p.replace(/^file:\/\/localhost/i, "file://").replace(/^file:(\/\/)?/i, "");
    p = safeDecode(p);
    if (/^\/[a-zA-Z]:[\\/]/.test(p)) p = p.slice(1); // file:///C:/repo/x
  } else {
    p = safeDecode(p);
  }
  if (!p) return null;
  let rel: string | null = null;
  if (p.startsWith("/") || DRIVE.test(p)) {
    for (const root of roots) {
      if (!root) continue;
      rel = worktreeRelative(root, p);
      if (rel) break;
    }
  } else {
    // Relative to the document, so it needs no root: the file route resolves
    // it inside the task's worktree either way.
    rel = joinRelative(baseDir, p) || null;
  }
  if (!rel) return null;
  const ext = extensionOf(rel);
  return { rel, open: isImageExt(ext) || BINARY_EXTS.has(ext) ? "raw" : "collab" };
}

/** The route that serves a worktree file's bytes with a browser-safe type. */
export function rawFileUrl(taskId: string, rel: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/file/raw?path=${encodeURIComponent(rel)}`;
}
