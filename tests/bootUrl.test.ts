/* The desktop boot-handoff URL predicate (#75).
 *
 * Pinned here in the vitest suite because `01-shell.spec.ts`'s lane runs only
 * under the `macos` label, a weekly cron, or a dispatch.
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
    // On macOS the window can reach the app before the first non-empty
    // `win.url()` read. Either side of that race is fine.
    expect(isBootHandoffUrl(ORIGIN, ORIGIN)).toBe(true);
    expect(isBootHandoffUrl(`${ORIGIN}/`, ORIGIN)).toBe(true);
  });

  it("still fails on the two things that have no benign reading", () => {
    // The window exists but no navigation landed inside the fixture's poll,
    // the case the firstUrl loop in fixtures.ts checks for.
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
