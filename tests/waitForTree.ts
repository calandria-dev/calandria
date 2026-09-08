/* Bounded polling for a process-tree probe, shared by the vitest unit tests
 * here and the Playwright desktop specs in `desktop/e2e/`, which import it as
 * `@/tests/waitForTree`. One tsconfig covers the whole repo, so the alias
 * resolves the same in either.
 *
 * A test that samples asynchronous OS state once and asserts on that instant
 * is unreliable on Windows (#99, #101, #75): the moment a process-tree fact
 * becomes true is not the moment the API that caused it returns. `taskkill
 * /T /F` returns once the kill is issued, not once the tree is gone, and a
 * freshly spawned child is not immediately discoverable through
 * `Win32_Process`. Whether a single sample lands on the right side of that
 * gap is scheduling, which is what an intermittent failure looks like.
 *
 * This never throws and never asserts. It returns the last sample it took,
 * settled or not, so the caller's own `expect(...)` is what fails. Call
 * sites carry diagnostics a generic timeout error would discard
 * (05-windows-quit's `sidecars.why()` dumps every child process the query
 * saw), and the assertion keeps its exact meaning without depending on the
 * instant the OS gets there.
 *
 * This stays out of `lib/processTree.ts`: making production code wait for a
 * `taskkill` to land would change its behavior to fix a test-timing problem,
 * and boot restore does not need the kill to have completed before it spawns
 * the replacement. It also stays out of `tests/platform.ts`, which imports
 * `vitest` and so cannot be imported from a Playwright spec.
 */

export type WaitForTreeOptions = {
  /**
   * Give up after this long and return whatever the last sample was.
   *
   * The default is well under vitest's 30s `testTimeout`: a poll that
   * outlasts it would turn a real failure into a bare "test timed out"
   * instead of the caller's own assertion. A Playwright caller passes its
   * own value, with a longer budget.
   */
  timeoutMs?: number;
  /** Gap between probes. */
  intervalMs?: number;
};

/**
 * Probe until `settled` accepts the sample or the deadline passes; return the
 * last sample either way.
 *
 * The probe always runs at least once, even at `timeoutMs: 0`. The deadline
 * is checked before each sleep, so a settled state that arrives in the final
 * interval is still observed.
 */
export async function waitForTree<T>(
  probe: () => T | Promise<T>,
  settled: (sample: T) => boolean,
  opts: WaitForTreeOptions = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  let sample = await probe();
  while (!settled(sample) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    sample = await probe();
  }
  return sample;
}
