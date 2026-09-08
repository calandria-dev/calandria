import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_MS, LIFECYCLE_LOG_LIMIT, formatLifecycleLog, heartbeatGap, isIOS, isStandaloneDisplay,
  parseLifecycleLog, pushLifecycleEvent, shouldReloadOnResume, terminalShouldSuspend, type LifecycleEvent,
} from "../app/shell/lifecycle";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD_AS_MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";

describe("lifecycle log: bounded, content-free, and readable after a force-quit", () => {
  it("keeps only the newest LIFECYCLE_LOG_LIMIT events", () => {
    let log: LifecycleEvent[] = [];
    for (let i = 0; i < LIFECYCLE_LOG_LIMIT + 25; i++) log = pushLifecycleEvent(log, { t: i, kind: "focus" });
    expect(log).toHaveLength(LIFECYCLE_LOG_LIMIT);
    expect(log[0].t).toBe(25);
    expect(log[log.length - 1].t).toBe(LIFECYCLE_LOG_LIMIT + 24);
  });

  it("parses what it wrote and shrugs off garbage", () => {
    const log = pushLifecycleEvent([], { t: 1, kind: "boot", standalone: true, ios: true });
    expect(parseLifecycleLog(JSON.stringify(log))).toEqual(log);
    expect(parseLifecycleLog(null)).toEqual([]);
    expect(parseLifecycleLog("not json")).toEqual([]);
    expect(parseLifecycleLog('{"a":1}')).toEqual([]);
    expect(parseLifecycleLog('[{"t":1,"kind":"focus"},{"nope":true},null]')).toEqual([{ t: 1, kind: "focus" }]);
  });

  it("formats one line per event, oldest first, in ISO time", () => {
    const text = formatLifecycleLog([
      { t: Date.UTC(2026, 8, 7, 12, 0, 0), kind: "hidden", online: true },
      { t: Date.UTC(2026, 8, 7, 12, 30, 0), kind: "heartbeat_gap", gapMs: 1_800_000, monoMs: 12 },
    ]);
    expect(text.split("\n")).toEqual([
      "2026-09-07T12:00:00.000Z hidden online=true",
      "2026-09-07T12:30:00.000Z heartbeat_gap gap=1800000ms mono=12ms",
    ]);
  });

  it("formats a socket that never opened", () => {
    const text = formatLifecycleLog([
      { t: Date.UTC(2026, 8, 7, 12, 0, 8), kind: "ws_stuck", waitMs: 8000, online: true },
    ]);
    expect(text).toBe("2026-09-07T12:00:08.000Z ws_stuck wait=8000ms online=true");
  });
});

describe("heartbeat: a late tick says timers were suspended, and the two clocks say how", () => {
  it("is quiet for a tick that lands on time or a little late", () => {
    expect(heartbeatGap(0, HEARTBEAT_MS, 0, HEARTBEAT_MS)).toBeNull();
    expect(heartbeatGap(0, HEARTBEAT_MS * 2 - 1, 0, HEARTBEAT_MS * 2 - 1)).toBeNull();
  });

  it("reports a suspension: the wall clock jumped while the monotonic clock barely moved", () => {
    const gap = heartbeatGap(1_000, 1_000 + 20 * 60_000, 500, 530);
    expect(gap).toEqual({ gapMs: 20 * 60_000, monoMs: 30 });
  });

  it("reports a throttle: both clocks advanced together", () => {
    const gap = heartbeatGap(0, 60_000, 0, 60_000);
    expect(gap).toEqual({ gapMs: 60_000, monoMs: 60_000 });
  });
});

describe("platform detection", () => {
  it("recognises the installed app through navigator.standalone or the display-mode query", () => {
    expect(isStandaloneDisplay({ standalone: true }, () => false)).toBe(true);
    expect(isStandaloneDisplay({}, (q) => q === "(display-mode: standalone)")).toBe(true);
    expect(isStandaloneDisplay({ standalone: false }, () => false)).toBe(false);
  });

  it("recognises iPhone, iPad, and iPadOS pretending to be a Mac", () => {
    expect(isIOS(IPHONE_UA)).toBe(true);
    expect(isIOS(IPAD_AS_MAC_UA, 5)).toBe(true);
    expect(isIOS(IPAD_AS_MAC_UA, 0)).toBe(false);
    expect(isIOS(ANDROID_UA, 5)).toBe(false);
  });
});

describe("shouldReloadOnResume: the one recovery the page can attempt, opt-in and iOS-installed only", () => {
  const base = { thresholdMinutes: 30, standalone: true, ios: true, hiddenSinceMs: 0, nowMs: 31 * 60_000 };

  it("reloads the installed iOS app after a background longer than the threshold", () => {
    expect(shouldReloadOnResume(base)).toBe(true);
    expect(shouldReloadOnResume({ ...base, nowMs: 30 * 60_000 })).toBe(true);
  });

  it("stays put for a short background", () => {
    expect(shouldReloadOnResume({ ...base, nowMs: 29 * 60_000 })).toBe(false);
  });

  it("is off by default (threshold 0) and off for a page that was never hidden", () => {
    expect(shouldReloadOnResume({ ...base, thresholdMinutes: 0 })).toBe(false);
    expect(shouldReloadOnResume({ ...base, hiddenSinceMs: null })).toBe(false);
  });

  it("never reloads a browser tab or a non-iOS device", () => {
    expect(shouldReloadOnResume({ ...base, standalone: false })).toBe(false);
    expect(shouldReloadOnResume({ ...base, ios: false })).toBe(false);
  });
});

describe("terminalShouldSuspend: a hidden phone terminal is torn down on background", () => {
  it("suspends the phone sheet only when it is hidden and the page goes to the background", () => {
    expect(terminalShouldSuspend({ mobile: true, sheetVisible: false, pageHidden: true })).toBe(true);
  });

  it("leaves a sheet the user is looking at alone", () => {
    expect(terminalShouldSuspend({ mobile: true, sheetVisible: true, pageHidden: true })).toBe(false);
  });

  it("does nothing while the page is in the foreground", () => {
    expect(terminalShouldSuspend({ mobile: true, sheetVisible: false, pageHidden: false })).toBe(false);
  });

  it("never suspends the desktop drawer, whose dev server is meant to outlive a background", () => {
    expect(terminalShouldSuspend({ mobile: false, sheetVisible: false, pageHidden: true })).toBe(false);
  });
});
