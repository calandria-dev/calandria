/**
 * What an attachment may be, what it is stored as, and what it is served back
 * as. Shared by the upload route, the serving route and the composer, and kept
 * dependency-free (no node builtins, no env reads) so the client bundle can
 * import it; lib/uploads.ts is the server half that touches the filesystem.
 *
 * The policy is extension-first instead of MIME-first. A browser fills
 * `file.type` from an OS registry: it is empty for anything unregistered
 * (`.log`, `.patch`, `.toml` on most Linux desktops), and inconsistent for the
 * rest (`.md` is `text/markdown`, `text/x-markdown` or `""` depending on the
 * machine), which is why a MIME whitelist previously pinned this to images.
 * The name the user picked is the signal that survives the round trip, and it
 * is the signal the agent needs too, since all it receives is the staged path
 * and it decides from the extension how to open the thing.
 *
 * Nothing here inspects file content. A staged file is never parsed, executed
 * or inlined into a prompt by Calandria; the two places bytes matter are the
 * size cap (CALANDRIA_MAX_UPLOAD_MB) and `servedType()` below, which is why an
 * open extension set is safe to accept.
 */

/** Default cap on a single attachment, overridden by CALANDRIA_MAX_UPLOAD_MB. */
export const DEFAULT_MAX_UPLOAD_MB = 25;

/** Extensions rendered as an image (composer thumbnail, transcript strip). */
export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** The reverse map, for the case where a filename has no usable extension: a
 *  clipboard screenshot, whose File carries a real MIME and a blank name. */
const EXT_BY_IMAGE_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Extensions served back to the browser as text/plain so a click previews them
 * in a tab. Markup and script extensions are in the list on purpose: served as
 * text/plain with `nosniff` they render as source instead of executing,
 * avoiding letting `.html` or `.svg` fall through to a sniffable type on a
 * same-origin route. Anything not listed and not an image is served as an
 * opaque download.
 */
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "rst", "log", "csv", "tsv", "json", "jsonl", "ndjson",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
  "xml", "html", "htm", "svg", "css", "scss",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "swift", "scala", "lua", "pl", "r",
  "sh", "bash", "zsh", "fish", "ps1", "bat",
  "sql", "graphql", "proto", "diff", "patch", "srt", "vtt",
]);

/** True for an extension the UI shows as a picture instead of a file chip. */
export const isImageExt = (ext: string): boolean => Object.hasOwn(IMAGE_MIME_BY_EXT, ext);

/**
 * The extension to stage a file under: 1-12 lowercase alphanumerics taken from
 * the user's own filename, falling back to the MIME type (clipboard images)
 * and finally to `bin`. Bounded and charset-restricted because this value ends
 * up in a path on disk and in a URL segment.
 */
export function uploadExtension(fileName: string, mimeType: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const fromName = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (/^[a-z0-9]{1,12}$/.test(fromName)) return fromName;
  const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (EXT_BY_IMAGE_MIME[mime]) return EXT_BY_IMAGE_MIME[mime];
  return mime.startsWith("text/") ? "txt" : "bin";
}

/**
 * The readable half of a staged filename. Every dot is stripped instead of
 * escaped, so `..` cannot be reconstructed at all, and the traversal guard on
 * the serving route is then a plain charset test instead of a sequence hunt.
 */
export function safeStem(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const cleaned = stem
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 48)
    .replace(/^[-_]+|[-_]+$/g, "");
  return cleaned || "file";
}

/** Length of the unique prefix `stagedFileName()` puts in front: nanoid()'s
 *  default. Fixed so displayFileName() can strip it back off for the UI. */
export const UNIQUE_PREFIX_LEN = 21;

/**
 * `<unique>-<user's name>.<ext>`. The unique prefix keeps the immutable cache
 * headers honest and makes collisions impossible; the user's name is kept
 * because it is what the transcript chip shows and, more importantly, what the
 * agent reads off the staged path when deciding how to process the file.
 */
export function stagedFileName(unique: string, fileName: string, mimeType: string): string {
  return `${unique}-${safeStem(fileName)}.${uploadExtension(fileName, mimeType)}`;
}

/** The staged name with its unique prefix stripped, i.e. roughly what the user
 *  called the file. Falls through unchanged for a legacy `<nanoid>.<ext>` name
 *  staged before filenames were preserved. */
export function displayFileName(staged: string): string {
  return staged.length > UNIQUE_PREFIX_LEN + 1 && staged[UNIQUE_PREFIX_LEN] === "-"
    ? staged.slice(UNIQUE_PREFIX_LEN + 1)
    : staged;
}

// Server-generated names only: `<unique>-<stem>.<ext>` where neither half can
// contain a dot or a slash (see safeStem/uploadExtension). This is the
// traversal guard for the serving route, so it is anchored and total.
const SAFE_UPLOAD_FILE = /^[A-Za-z0-9_-]+\.([a-z0-9]{1,12})$/;

/** Validate a served filename and pull its extension, or null if it isn't ours. */
export function parseStagedFile(file: string): { ext: string } | null {
  const m = SAFE_UPLOAD_FILE.exec(file);
  return m ? { ext: m[1] } : null;
}

/**
 * How to hand a staged file back over HTTP. Only images and known text formats
 * get a real content type; everything else is an opaque download, so an
 * arbitrary upload can never be interpreted as active content on this origin.
 */
export function servedType(ext: string): { contentType: string; download: boolean } {
  const image = IMAGE_MIME_BY_EXT[ext];
  if (image) return { contentType: image, download: false };
  if (TEXT_EXTS.has(ext)) return { contentType: "text/plain; charset=utf-8", download: false };
  return { contentType: "application/octet-stream", download: true };
}

/**
 * The size cap as the client sees it. The server is the authority (the upload
 * route rejects on Content-Length before buffering anything); this mirror only
 * exists so the composer can refuse a 2 GB drop without pushing it over the
 * wire first. Injected as `window.__MAX_UPLOAD_MB` by app/layout.tsx, the same
 * way PUBLIC_BASE_URL crosses the boundary.
 */
export function maxUploadBytes(): number {
  const mb = typeof window === "undefined"
    ? undefined
    : (window as unknown as { __MAX_UPLOAD_MB?: number }).__MAX_UPLOAD_MB;
  return (typeof mb === "number" && mb > 0 ? mb : DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;
}
