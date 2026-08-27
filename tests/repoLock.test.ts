import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression: withRepoLock keyed on the caller's `project.repo_path` verbatim,
// so two spellings of the SAME repository — a symlinked path, a trailing slash,
// or two projects configured against one repo — took two different locks and
// ran concurrently. That's exactly what the lock exists to prevent: two merges
// racing the main tree's HEAD/index, or a worktree cut mid-merge handing back a
// base_sha read off a transient HEAD. The key is now the repo's common git dir,
// which git canonicalizes and shares across every linked worktree.
import { repoLockKey, withRepoLock } from "../lib/repoLock";
import { ensureWorktree } from "../lib/git";
import { git, makeRepo, tmpDir, uid } from "./helpers";
import { canonicalPath } from "@/lib/paths";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// Negative-timing exception only: proving a queued caller has NOT run yet
// requires letting its real git subprocess have a fair chance to run if the
// lock were broken — there's no event to poll for an absence, and fake timers
// don't advance real child-process I/O. Every other wait below polls a real
// condition instead (see repoLockKey + the lock registry, or `order`/`ran`
// directly).
const settle = () => new Promise((r) => setTimeout(r, 50));

/**
 * `<kind>:` followed by an ABSOLUTE path — `/...` on POSIX, `C:\...` on Windows.
 * What the assertion is really about is that the key is namespaced and can't be
 * a relative answer two callers would spell differently; the leading slash was
 * only ever how that looked on POSIX.
 */
const KEYED_ABSOLUTE = (kind: string) => new RegExp(`^${kind}:(/|[A-Za-z]:\\\\)`);

/** `repo` reachable through a symlinked directory, the way /tmp -> /private/tmp is. */
function symlinkTo(repo: string): string {
  const link = path.join(tmpDir("link-"), "repo");
  // "junction" on Windows: a plain directory symlink there needs Developer Mode
  // or an elevated process, while a junction needs neither — and both are what
  // realpathSync resolves through, which is the property under test.
  fs.symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");
  return link;
}

beforeEach(() => {
  global.__calandriaRepoLocks?.clear();
  global.__calandriaRepoLockKeys?.clear();
});

describe("repoLockKey", () => {
  it("is identical for every spelling of the same repo", async () => {
    const repo = await makeRepo();
    const canonical = await repoLockKey(repo);
    expect(canonical).toMatch(KEYED_ABSOLUTE("git"));
    expect(await repoLockKey(symlinkTo(repo))).toBe(canonical);
    expect(await repoLockKey(repo + "/")).toBe(canonical);
    expect(await repoLockKey(repo + "/.")).toBe(canonical);
  });

  it("is identical for a repo and a linked worktree of it", async () => {
    const repo = await makeRepo();
    const wt = await ensureWorktree(repo, uid());
    expect(wt).not.toBeNull();
    expect(await repoLockKey(wt!.path)).toBe(await repoLockKey(repo));
  });

  it("is identical for a subdirectory of the repo", async () => {
    const repo = await makeRepo();
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    expect(await repoLockKey(path.join(repo, "src", "deep"))).toBe(await repoLockKey(repo));
  });

  it("separates genuinely different repos", async () => {
    expect(await repoLockKey(await makeRepo())).not.toBe(await repoLockKey(await makeRepo()));
  });

  it("falls back to the canonicalized path for a non-git directory", async () => {
    const dir = tmpDir("plain-");
    const key = await repoLockKey(dir);
    expect(key).toMatch(KEYED_ABSOLUTE("path"));
    // A greenfield project still serializes across spellings while it waits.
    expect(await repoLockKey(dir + "/")).toBe(key);
    expect(await repoLockKey(symlinkTo(dir))).toBe(key);
    // ...and doesn't throw on a path that isn't there at all.
    expect(await repoLockKey(path.join(dir, "missing"))).toMatch(KEYED_ABSOLUTE("path"));
  });

  it("does not cache the miss — a dir that becomes a repo re-resolves", async () => {
    // ensureWorktree inits greenfield projects, so this transition is routine.
    // A remembered "not a repo" would key the calls after the init differently
    // from the ones before it — two locks over one repo again.
    const dir = tmpDir("greenfield-");
    expect(await repoLockKey(dir)).toMatch(KEYED_ABSOLUTE("path"));
    await git(dir, "init", "-b", "main");
    expect(await repoLockKey(dir)).toMatch(KEYED_ABSOLUTE("git"));
  });

  it("caches the hit, so the hot path doesn't respawn git", async () => {
    const repo = await makeRepo();
    await repoLockKey(repo);
    expect(global.__calandriaRepoLockKeys!.has(repo)).toBe(true);
    // Same promise instance back — no second subprocess.
    expect(repoLockKey(repo)).toBe(global.__calandriaRepoLockKeys!.get(repo));
  });
});

describe("withRepoLock", () => {
  it("serializes a worktree cut through a symlink against a holder on the real path", async () => {
    const repo = await makeRepo();
    const link = symlinkTo(repo);
    const order: string[] = [];
    const gate = deferred();

    // Stand in for the slow critical section a merge holds.
    const holder = withRepoLock(repo, async () => {
      order.push("holder-in");
      await gate.promise;
      order.push("holder-out");
    });
    // Wait for the holder's critical section to actually start, not just for
    // withRepoLock to have been called.
    await vi.waitFor(() => expect(order).toEqual(["holder-in"]));

    const cut = ensureWorktree(link, uid()).then((wt) => {
      order.push("worktree-cut");
      return wt;
    });
    // Negative timing assertion (see comment on `settle`): give the symlinked
    // ensureWorktree a real subprocess's worth of time to have raced ahead of
    // the holder if the lock didn't actually cover it.
    await settle();
    // Pre-fix this read ["holder-in", "worktree-cut"]: the symlinked spelling
    // took its own lock and cut the worktree straight through the merge.
    expect(order).toEqual(["holder-in"]);

    gate.resolve();
    const [, wt] = await Promise.all([holder, cut]);
    expect(order).toEqual(["holder-in", "holder-out", "worktree-cut"]);
    expect(wt).not.toBeNull();
  });

  it("queues two ensureWorktree calls — one symlinked, one real — on one lock", async () => {
    const repo = await makeRepo();
    const link = symlinkTo(repo);
    const gate = deferred();
    const holder = withRepoLock(repo, () => gate.promise);
    // Wait for the holder to actually be registered in the lock table before
    // firing the two racing calls, so both are guaranteed to queue behind it.
    const key = await repoLockKey(repo);
    await vi.waitFor(() => expect(global.__calandriaRepoLocks?.has(key)).toBe(true));

    const done: string[] = [];
    const a = ensureWorktree(repo, uid()).then((wt) => (done.push("a"), wt));
    const b = ensureWorktree(link, uid()).then((wt) => (done.push("b"), wt));
    // Negative timing assertion (see comment on `settle`): `b`'s lock key isn't
    // cached yet, so this gives its real `git rev-parse` subprocess — and a's
    // real worktree-add, if the lock didn't actually serialize them — a fair
    // chance to have run.
    await settle();

    // Both are parked behind the holder, on ONE queue — the whole point. Two
    // entries (or a finished call) means the spellings ran their git mutations
    // concurrently; pre-fix `b` was already done here.
    expect(done).toEqual([]);
    expect([...global.__calandriaRepoLocks!.keys()]).toHaveLength(1);

    gate.resolve();
    const [wtA, wtB] = await Promise.all([a, b, holder]);
    // Both still got a real, distinct worktree out of the serialized run.
    expect(wtA!.path).not.toBe(wtB!.path);
    for (const wt of [wtA!, wtB!]) expect(fs.existsSync(path.join(wt.path, "file.txt"))).toBe(true);
    // `git worktree list` prints C:/Users/... on Windows where path.join built
    // C:\Users\..., so the two sides are compared through canonicalPath rather
    // than as raw strings (lib/paths.ts).
    const listed = (await git(repo, "worktree", "list", "--porcelain"))
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => canonicalPath(line.slice("worktree ".length).trim()));
    expect(listed).toContain(canonicalPath(wtA!.path));
    expect(listed).toContain(canonicalPath(wtB!.path));
  });

  it("still lets unrelated repos run concurrently", async () => {
    const one = await makeRepo();
    const two = await makeRepo();
    const gate = deferred();
    let ran = false;
    const holder = withRepoLock(one, () => gate.promise);
    // Wait for the holder to be registered before firing the unrelated repo's
    // lock, so this is genuinely testing two different keys, not a race.
    const oneKey = await repoLockKey(one);
    await vi.waitFor(() => expect(global.__calandriaRepoLocks?.has(oneKey)).toBe(true));
    const other = withRepoLock(two, async () => {
      ran = true;
    });
    await vi.waitFor(() => expect(ran).toBe(true));
    gate.resolve();
    await Promise.all([holder, other]);
  });

  it("returns fn's rejection to its own caller without poisoning the queue", async () => {
    const repo = await makeRepo();
    const link = symlinkTo(repo);
    const boom = withRepoLock(repo, async () => {
      throw new Error("boom");
    });
    const after = withRepoLock(link, async () => "fine");
    await expect(boom).rejects.toThrow("boom");
    expect(await after).toBe("fine");
  });
});
