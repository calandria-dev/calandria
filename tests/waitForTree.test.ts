/* The bounded-poll helper both suites use to stop sampling asynchronous process
 * state once (#99, #101).
 *
 * Every case here is a shape a real flake had. They run on every lane, unlike
 * the Windows and macOS lanes the flakes themselves live on, which are
 * label-gated.
 */
import { describe, expect, it } from "vitest";
import { waitForTree } from "./waitForTree";

describe("waitForTree", () => {
  it("keeps probing until the tree is gone, instead of asserting on the first sample", async () => {
    // #99's shape: `taskkill /T /F` has returned, but the OS has not finished
    // tearing the tree down, so the first two probes still see it.
    let probes = 0;
    const alive = await waitForTree(
      () => ++probes < 3,
      (stillAlive) => !stillAlive,
      { timeoutMs: 5_000, intervalMs: 1 }
    );
    expect(alive).toBe(false);
    expect(probes).toBe(3);
  });

  it("returns the last unsettled sample rather than throwing, so the caller's assertion is what fails", async () => {
    // The call sites carry diagnostics (05-windows-quit's `sidecars.why()`
    // dumps every child process the query saw) that a helper-thrown timeout
    // would replace with a shrug. A tree that never dies must still fail, and
    // must fail THERE.
    const started = Date.now();
    const alive = await waitForTree(
      () => true,
      (stillAlive) => !stillAlive,
      { timeoutMs: 60, intervalMs: 5 }
    );
    expect(alive).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it("waits for a record to be complete, and hands back the incomplete one on timeout", async () => {
    // #101's shape: the sidecar lookup returns a record, and "settled" means
    // both children have become discoverable. The half-populated record has to
    // reach the caller intact — it is the report.
    let probes = 0;
    const sidecars = await waitForTree(
      () => ({ app: 100, pty: ++probes >= 4 ? 200 : null }),
      (s) => !!s.app && !!s.pty,
      { timeoutMs: 5_000, intervalMs: 1 }
    );
    expect(sidecars).toEqual({ app: 100, pty: 200 });

    const never = await waitForTree(
      () => ({ app: 100, pty: null as number | null }),
      (s) => !!s.app && !!s.pty,
      { timeoutMs: 20, intervalMs: 5 }
    );
    expect(never).toEqual({ app: 100, pty: null });
  });

  it("probes at least once even with no time to spare, so it is never weaker than one sample", async () => {
    let probes = 0;
    const alive = await waitForTree(
      () => {
        probes++;
        return false;
      },
      (stillAlive) => !stillAlive,
      { timeoutMs: 0, intervalMs: 1 }
    );
    expect(alive).toBe(false);
    expect(probes).toBe(1);
  });

  it("awaits an async probe", async () => {
    let probes = 0;
    const alive = await waitForTree(
      async () => ++probes < 2,
      (stillAlive) => !stillAlive,
      { timeoutMs: 5_000, intervalMs: 1 }
    );
    expect(alive).toBe(false);
    expect(probes).toBe(2);
  });
});
