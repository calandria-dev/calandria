// Pins the repo's line-ending contract: LF in the index, LF in every working
// tree, on every platform.
//
// `.gitattributes` is one line (`* text=auto eol=lf`) and nothing in the build
// regenerates it, so unlike `tests/lockfileGypfile.test.ts` this is not
// guarding against a tool that deletes the fix. It guards against the fix being
// deleted by hand, weakened, or quietly bypassed — and, more usefully, against
// a CRLF file being committed regardless of how the attribute is spelled.
//
// Why it matters is a Windows-only story with no Linux symptom. Before the
// attribute existed the repo had NO attributes at all, so what landed in a
// Windows checkout was decided by that machine's `core.autocrlf`, a per-machine
// setting the repo can't see and CI doesn't share. Nothing was broken at the
// time (the sweep for issue #53 checked): the recorded Codex JSONL fixtures are
// `JSON.parse`d, and JSON's grammar treats a trailing CR as whitespace;
// `tests/naming.test.ts` splits every tracked file into lines but has no
// `$`-anchored pattern in it. The exposure is the NEXT test — a snapshot, an
// anchored regex, a fixture compared byte-for-byte — which would pass for
// everyone who wrote it and fail only on Windows, and only for the subset of
// Windows developers with `core.autocrlf=true`.
//
// This is deliberately NOT `outputLines` territory. That helper (same issue)
// covers what a native Windows binary writes to a PIPE. This covers what git
// writes to DISK. Same `\r`, different cause, and a fix for one does nothing
// for the other.
//
// To fix a failure:
//
//   * "no longer resolves to text=auto eol=lf" — `.gitattributes` was deleted
//     or edited. Restore the line rather than adding a per-path exception; the
//     value of a blanket rule is that a new file inherits it.
//   * "is not treated as binary" — someone hardened `text=auto` into a bare
//     `text`. That takes git's content detection out of the loop and normalizes
//     the tracked PNGs, WEBPs and WOFF2s on checkout, corrupting them. Put the
//     `auto` back.
//   * "committed with CRLF" — a file was added from a Windows checkout with
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
 * there is one subprocess rather than a `check-attr` per case. `-z` is for the
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
    // them on the next Windows checkout, which no unit test would notice —
    // hence pinning it here, on the real tree rather than a list of names.
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
    // The guarantee itself, asserted on the stored bytes rather than on the
    // attribute that is supposed to produce them. It survives someone replacing
    // the mechanism, and it is what actually keeps a `$`-anchored assertion or
    // a byte-for-byte fixture comparison honest on a Windows lane.
    const dirty = files.filter((f) => f.index === "crlf" || f.index === "mixed");
    expect(
      dirty.map((f) => `${f.file} (i/${f.index})`),
      "these were committed with CRLF, so a Linux checkout gets carriage returns git will never strip — run `git add --renormalize` on them and commit",
    ).toEqual([]);
  });
});
