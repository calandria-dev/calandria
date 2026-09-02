/* The desktop boot-handoff URL predicate (#75).
 *
 * It is pinned from the vitest suite rather than only from `01-shell.spec.ts`,
 * because that spec's lane is reachable only by the `macos` label, a weekly
 * cron or a dispatch — a case living only there is checked a handful of times a
 * year, which is how long the flake it fixes went unnoticed.
 */
import { describe, expect, it } from "vitest";
import { isBootHandoffUrl } from "../desktop/e2e/bootUrl";

const ORIGIN = "http://127.0.0.1:4741";

describe("isBootHandoffUrl", () => {
  it("accepts the boot screen the window is created on", () => {
    expect(isBootHandoffUrl("file:///opt/app/desktop/loading.html", ORIGIN)).toBe(true);
    expect(isBootHandoffUrl("file:///opt/app/desktop/loading.html?x=1", ORIGIN)).toBe(true);
    expect(isBootHandoffUrl("about:blank", ORIGIN)).toBe(true);
  });

  it("accepts the app, because a fast boot can swap before the fixture looks", () => {
    // The whole of #75: on macOS the window can reach the app before the first
    // non-empty `win.url()` read, and the shell doing its job promptly is not a
    // failure. Either side of the race is fine.
    expect(isBootHandoffUrl(ORIGIN, ORIGIN)).toBe(true);
    expect(isBootHandoffUrl(`${ORIGIN}/`, ORIGIN)).toBe(true);
  });

  it("still fails on the two things that have no benign reading", () => {
    // The window exists but landed no navigation inside the fixture's poll —
    // what the firstUrl loop in fixtures.ts was added to catch.
    expect(isBootHandoffUrl("", ORIGIN)).toBe(false);
    // Somewhere that is neither the boot screen nor this instance.
    expect(isBootHandoffUrl("http://example.com/", ORIGIN)).toBe(false);
    expect(isBootHandoffUrl("http://127.0.0.1:9999/", ORIGIN)).toBe(false);
  });

  it("does not let an unread origin turn into a wildcard", () => {
    // `origin` is "" when the fixture could not read it back off the window; a
    // bare startsWith("") would then accept literally any URL.
    expect(isBootHandoffUrl("http://example.com/", "")).toBe(false);
    expect(isBootHandoffUrl("file:///opt/app/desktop/loading.html", "")).toBe(true);
  });
});
