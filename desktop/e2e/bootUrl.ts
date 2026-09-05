/* The boot-handoff URL predicate, in its own module so the vitest suite can pin
 * it (`tests/bootUrl.test.ts`). The macOS desktop lane it guards is reachable
 * only by the `macos` label, a weekly cron or a dispatch, so a case that only
 * lived in the spec would be checked a handful of times a year.
 *
 * Playwright is not imported here, which is what makes it importable from
 * `tests/`.
 */

/**
 * Is the URL the window was first seen on consistent with the boot handoff?
 *
 * `main.js` creates the window on `loading.html` and swaps it to the app once
 * `/api/version` answers. On a fast macOS boot the swap can land before the
 * first non-empty read, so the fixture's first sighting is already the app
 * (#75), which is correct shell behavior. The assertion accepts either side of
 * the race instead of relying on a bumped timeout, which would only move the
 * gap. What stays pinned is the part with no benign reading: the window came
 * up on the boot screen or on the app, and on nothing else. An empty URL (the
 * window exists but has landed no navigation) and a foreign origin both still
 * fail, and the test's other two claims, that the supervisor narrated its
 * start and that those lines reached the boot screen through
 * `executeJavaScript`, are untouched.
 */
export function isBootHandoffUrl(firstUrl: string, origin: string): boolean {
  if (!firstUrl) return false; // never navigated: a real failure, and still one
  if (firstUrl === "about:blank") return true;
  // A file:// URL, possibly with a query or hash Electron appended.
  if (/loading\.html(?:[?#].*)?$/.test(firstUrl)) return true;
  // The swap already landed. `origin` is read back off the window instead of
  // assumed, and is "" when even that failed, which must not turn into a
  // `startsWith("")` that accepts everything.
  return !!origin && firstUrl.startsWith(origin);
}
