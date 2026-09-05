// Pins the repo's line-ending contract: LF in the index, LF in every working
// tree, on every platform.
//
// `.gitattributes` is one line (`* text=auto eol=lf`). Nothing in the build
// regenerates it, so unlike `tests/lockfileGypfile.test.ts` this is not
// guarding against a tool that deletes the fix. It guards against the fix
// being deleted by hand, weakened, or bypassed without anyone noticing, and,
// more usefully, against a CRLF file being committed regardless of how the
// attribute is spelled.
//
// This matters only on Windows, with no Linux symptom. With no attributes at
// all, what lands in a Windows checkout is decided by that machine's
// `core.autocrlf`, a per-machine setting the repo cannot see and CI does not
// share. The recorded Codex JSONL fixtures are `JSON.parse`d, and JSON's
// grammar treats a trailing CR as whitespace (issue #53's sweep found nothing
// broken at the time); `tests/naming.test.ts` splits every tracked file into
// lines but has no `$`-anchored pattern in it. The exposure is the next test:
// a snapshot, an anchored regex, a fixture compared byte-for-byte, which would
// pass for everyone who wrote it and fail only on Windows, and only for the
// subset of Windows developers with `core.autocrlf=true`.
//
// This is not `outputLines` territory. That helper (same issue) covers what a
// native Windows binary writes to a pipe. This covers what git writes to
// disk. Same `\r`, different cause, and a fix for one does nothing for the
// other.
//
// To fix a failure:
//
//   * "no longer resolves to text=auto eol=lf": `.gitattributes` was deleted
//     or edited. Restore the line instead of adding a per-path exception; a
//     blanket rule's value is that a new file inherits it.
//   * "is not treated as binary": `text=auto` was hardened into a bare
//     `text`. That takes git's content detection out of the loop and
//     normalizes the tracked PNGs, WEBPs and WOFF2s on checkout, corrupting
//     them. Put the `auto` back.
//   * "committed with CRLF": a file was added from a Windows checkout with
//     conversion off. `git add --renormalize <path>` and commit the result.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

type TrackedFile = {
  file: string;
  /** Line endings as stored in the index: `lf`, `crlf`, `mixed`, `none` or `-text`. */
  index: string;
  /** Line endings in the working tree, same vocabulary. */
  worktree: string;
  /** The attributes git resolved for the path, e.g. `text=auto eol=lf`. */
  attrs: string;
};

/**
 * Every tracked path with its line-ending facts, or null when git can't answer.
 *
 * Null is not a failure for the same reason `tests/naming.test.ts` tolerates
 * it: under `npm run test:docker` a task worktree's `.git` file points outside
 * the mount, so `git ls-files` exits non-zero (`e2e/README.md` records the same
 * red herring). CI runs against a real clone, and that is the run that gates a
 * merge.
 *
 * One `git ls-files --eol` carries all three facts this file asserts on, so
 * there is one subprocess instead of a `check-attr` per case. `-z` is for the
 * separator between ENTRIES; within an entry the path still follows a tab, so
 * the split below takes the first tab only.
 */
function trackedFiles(): TrackedFile[] | null {
  let out: Buffer;
  try {
    out = execFileSync("git", ["ls-files", "--eol", "-z"], {
      cwd: ROOT,
      maxBuffer: 32 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const files: TrackedFile[] = [];
  for (const entry of out.toString("utf8").split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const m = /^i\/(\S+)\s+w\/(\S+)\s+attr\/(.*?)\s*$/.exec(entry.slice(0, tab));
    if (!m) continue;
    files.push({ file: entry.slice(tab + 1), index: m[1], worktree: m[2], attrs: m[3] });
  }
  return files;
}

describe(".gitattributes pins LF line endings", () => {
  it("resolves `text=auto eol=lf` for every tracked path", (ctx) => {
    const files = trackedFiles();
    if (!files) return ctx.skip("git ls-files unavailable (worktree .git is outside the mount)");
    // Canary: an empty list would pass the loop vacuously.
    expect(files.length, "git ls-files --eol returned nothing at all").toBeGreaterThan(100);
    const unpinned = files.filter((f) => f.attrs !== "text=auto eol=lf").map((f) => f.file);
    expect(
      unpinned,
      "these tracked paths no longer resolve to `text=auto eol=lf`, so what a Windows checkout writes to disk is back to depending on that machine's `core.autocrlf` — restore the line in .gitattributes",
    ).toEqual([]);
  });

  it("leaves binary content to git's own detection", (ctx) => {
    const files = trackedFiles();
    if (!files) return ctx.skip("git ls-files unavailable (worktree .git is outside the mount)");
    // The tracked binaries: images, fonts, the webp screenshots. `text=auto`
    // means git sniffs content and marks these `-text`, so `eol=lf` never
    // reaches them. A bare `text` would instead force conversion and corrupt
    // them on the next Windows checkout, which no unit test would notice,
    // which is why this is pinned on the real tree instead of a list of names.
    const binary = files.filter((f) => f.index === "-text");
    expect(
      binary.length,
      "no tracked file is detected as binary any more — either the images left the repo, or `text=auto` was hardened into a bare `text`",
    ).toBeGreaterThan(0);
    const converted = binary.filter((f) => f.worktree !== "-text").map((f) => f.file);
    expect(
      converted,
      "these are binary in the index but not in the working tree, so git is line-ending-converting them on checkout",
    ).toEqual([]);
  });

  it("has nothing committed with CRLF", (ctx) => {
    const files = trackedFiles();
    if (!files) return ctx.skip("git ls-files unavailable (worktree .git is outside the mount)");
    // The guarantee itself, asserted on the stored bytes instead of on the
    // attribute that is supposed to produce them. It survives someone
    // replacing the mechanism, and it is what keeps a `$`-anchored assertion
    // or a byte-for-byte fixture comparison honest on a Windows lane.
    const dirty = files.filter((f) => f.index === "crlf" || f.index === "mixed");
    expect(
      dirty.map((f) => `${f.file} (i/${f.index})`),
      "these were committed with CRLF, so a Linux checkout gets carriage returns git will never strip — run `git add --renormalize` on them and commit",
    ).toEqual([]);
  });
});
