import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// `isLinkedWorktree` (lib/git.ts) and `pathIdentity` (lib/repoLock.ts) each
// compare `fs.realpathSync` output with `===`. NTFS is case-insensitive but
// `realpathSync` is only case-preserving, so `C:\Users\Foo` and `c:\users\foo`
// (one directory) would compare unequal as strings. A false "not linked" is
// what authorizes `rmSync(wtPath, { recursive, force })` on a live checkout;
// in the repo lock it means two spellings of one repo take two locks and run
// merges concurrently that this is meant to serialize. Both go through one
// helper, so the two can't drift.
import { canonicalPath, heldHandleHint, samePath } from "../lib/paths";
import { repoLockKey } from "../lib/repoLock";
import { tmpDir } from "./helpers";

const REAL_PLATFORM = process.platform;

/** Pretend to be `p` for the duration of a test. `process.platform` is a plain
 *  data property, so `vi.spyOn(…, "get")` can't touch it. */
function mockPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

afterEach(() => {
  mockPlatform(REAL_PLATFORM);
  global.__calandriaRepoLockKeys?.clear();
});

/** An existing directory plus an all-caps spelling of it that doesn't resolve.
 *  One side comes back from `realpathSync`, the other falls through to
 *  `path.resolve`, and only case-folding reconciles them. */
function caseVariant(): { dir: string; shouted: string } {
  const dir = fs.realpathSync(tmpDir("case-"));
  return { dir, shouted: dir.toUpperCase() };
}

describe("samePath folds case on win32 only", () => {
  it("treats two case spellings of one directory as the same path on win32", () => {
    const { dir, shouted } = caseVariant();
    mockPlatform("win32");
    expect(samePath(dir, shouted)).toBe(true);
    expect(canonicalPath(shouted)).toBe(canonicalPath(dir));
  });

  it("keeps them distinct on POSIX, where they really are two paths", () => {
    const { dir, shouted } = caseVariant();
    mockPlatform("linux");
    expect(samePath(dir, shouted)).toBe(false);
  });

  it("still resolves symlinks and redundant segments on both platforms", () => {
    const target = fs.realpathSync(tmpDir("target-"));
    const link = path.join(tmpDir("link-"), "alias");
    fs.symlinkSync(target, link);
    const noisy = path.join(target, "sub", "..", ".");
    fs.mkdirSync(path.join(target, "sub"));

    for (const platform of ["linux", "win32"] as const) {
      mockPlatform(platform);
      expect(samePath(link, target)).toBe(true);
      expect(samePath(noisy, target)).toBe(true);
    }
  });

  it("is reflexive for a path that doesn't exist, rather than throwing", () => {
    const gone = path.join(tmpDir("gone-"), "never", "created");
    mockPlatform("win32");
    expect(samePath(gone, gone)).toBe(true);
    expect(canonicalPath(gone)).toBe(gone.toLowerCase());
  });
});

describe("the repo lock keys two case spellings of one repo together on win32", () => {
  // A directory with no git repo in it, which is what makes `repoLockKey` fall
  // through to the path identity: the greenfield-project case, and the only
  // one where the comparison is ours instead of git's.
  it("hands both spellings the same lock key", async () => {
    const { dir, shouted } = caseVariant();
    mockPlatform("win32");
    expect(await repoLockKey(shouted)).toBe(await repoLockKey(dir));
  });

  it("hands them different keys on POSIX", async () => {
    const { dir, shouted } = caseVariant();
    mockPlatform("linux");
    expect(await repoLockKey(shouted)).not.toBe(await repoLockKey(dir));
  });
});

describe("heldHandleHint names the likely holder, on Windows only", () => {
  it("blames an open terminal or editor on win32", () => {
    mockPlatform("win32");
    expect(heldHandleHint()).toContain("terminal or editor");
  });

  it("says nothing on POSIX, where an open handle isn't why a delete failed", () => {
    mockPlatform("linux");
    expect(heldHandleHint()).toBe("");
  });
});
