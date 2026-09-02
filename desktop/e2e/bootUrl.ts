/* The boot-handoff URL predicate, in its own module so the vitest suite can pin
 * it (`tests/bootUrl.test.ts`). The macOS desktop lane it guards is reachable
 * only by the `macos` label, a weekly cron or a dispatch, so a case that only
 * lived in the spec would be checked a handful of times a year.
 *
 * Nothing Playwright is imported here, which is what makes it importable from
 * `tests/`.
 */

/**
 * Is the URL the window was FIRST seen on consistent with the boot handoff?
 *
 * `main.js` creates the window on `loading.html` and swaps it to the app once
 * `/api/version` answers. `01-shell` used to require the first observed URL to
 * still be the boot screen, on the reasoning that the fixture samples long
 * before the server can be up. On a fast macOS boot it isn't: the swap can land
 * before the first non-empty read, so the fixture's first sighting is already
 * the app (#75). That is the shell behaving *correctly*, and the test failed
 * for it — three steps red, packaging never reached.
 *
 * So the assertion is loosened to accept EITHER SIDE of the race rather than
 * having its timeout bumped, which would only move the gap. What is still
 * pinned is the part that has no benign reading: the window came up on the boot
 * screen or on the app, and on nothing else. An empty URL (the window exists
 * but has landed no navigation) and a foreign origin both still fail, and the
 * two load-bearing claims of that test — the supervisor narrated its start, and
 * those lines reached the boot screen through `executeJavaScript` — are
 * untouched and never flaked.
 */
export function isBootHandoffUrl(firstUrl: string, origin: string): boolean {
  if (!firstUrl) return false; // never navigated: a real failure, and still one
  if (firstUrl === "about:blank") return true;
  // A file:// URL, possibly with a query or hash Electron appended.
  if (/loading\.html(?:[?#].*)?$/.test(firstUrl)) return true;
  // The swap already landed. `origin` is read back off the window rather than
  // assumed, and is "" when even that failed — which must not turn into a
  // `startsWith("")` that accepts everything.
  return !!origin && firstUrl.startsWith(origin);
}
