/* Bounded polling for a process-tree probe, shared by BOTH suites — the vitest
 * unit tests here and the Playwright desktop specs in `desktop/e2e/`, which
 * import it as `@/tests/waitForTree`. One tsconfig covers the whole repo, so
 * the alias resolves the same in either.
 *
 * WHY IT EXISTS. Three flakes (#99, #101, #75) turned out to be one bug written
 * three times: a test samples asynchronous OS state ONCE and asserts on that
 * instant. On Windows especially, the moment a process-tree fact becomes true is
 * not the moment the API that caused it returns — `taskkill /T /F` comes back
 * once the kill is *issued*, not once the tree is gone (#99), and a freshly
 * spawned child is not immediately discoverable through `Win32_Process` (#101).
 * Whether the sample lands on the right side of that gap is scheduling, which is
 * exactly what an intermittent failure looks like.
 *
 * THE SHAPE, AND THE ONE THING THAT IS NOT OBVIOUS ABOUT IT. This never throws
 * and never asserts. It returns the LAST SAMPLE it took, settled or not, and the
 * caller's existing `expect(...)` is still what fails. That is deliberate: the
 * call sites carry diagnostics a generic timeout error would throw away — the
 * whole `sidecars.why()` dump of every child process the query saw, in
 * `05-windows-quit.spec.ts` — and a helper that raised its own "timed out"
 * would replace a report with a shrug. The assertion keeps its exact meaning
 * (the tree IS reaped / the sidecars DO come up, and the test still fails if
 * they never do) while no longer depending on the instant the OS gets there.
 *
 * Deliberately NOT in `lib/processTree.ts`: making production code wait for a
 * `taskkill` to land would be a behaviour change to fix a test-timing problem,
 * and boot restore genuinely does not care whether the kill has completed
 * before it spawns the replacement (#99). Deliberately not in
 * `tests/platform.ts` either — that module imports `vitest`, which a Playwright
 * spec cannot.
 */

export type WaitForTreeOptions = {
  /**
   * Give up after this long and return whatever the last sample was.
   *
   * The default is well under vitest's 30s `testTimeout`, on purpose: a poll
   * that outlasts it would turn a real failure into a bare "test timed out",
   * discarding the assertion that was about to explain itself. A Playwright
   * caller, with its own longer budget, passes its own value.
   */
  timeoutMs?: number;
  /** Gap between probes. */
  intervalMs?: number;
};

/**
 * Probe until `settled` accepts the sample or the deadline passes; return the
 * last sample either way.
 *
 * The probe always runs at least once, even at `timeoutMs: 0`, so this is never
 * weaker than the single sample it replaces. The deadline is checked before
 * each *sleep* rather than before each probe, so a settled state that arrives
 * in the final interval is still seen.
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
