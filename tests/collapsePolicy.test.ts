import { describe, expect, it } from "vitest";
import {
  INITIAL_POLICY, NOTHING_SHED, applyShed, applyOverride, isCollapsed, shedLabel, type ShedSet,
} from "../app/shell/collapsePolicy";

// The shed sets AUTO_COLLAPSE_BELOW implies at the widths the e2e drives.
const AT_1440: ShedSet = NOTHING_SHED;
const AT_1024: ShedSet = { proj: true, task: true, rail: false };
const AT_800: ShedSet = { proj: true, task: true, rail: true };

describe("collapsePolicy — an override is good at the shed set it was granted under", () => {
  it("sheds what the width implies, and a spine click reopens it there", () => {
    const p = applyShed(INITIAL_POLICY, AT_1024);
    expect(isCollapsed(p, "proj", false)).toBe(true);
    expect(isCollapsed(p, "task", false)).toBe(true);
    expect(isCollapsed(p, "rail", false)).toBe(false);

    const reopened = applyOverride(p, "proj", true);
    expect(isCollapsed(reopened, "proj", false)).toBe(false);
    expect(isCollapsed(reopened, "task", false)).toBe(true);
  });

  it("the user's own persisted collapse outranks the override", () => {
    const p = applyOverride(applyShed(INITIAL_POLICY, AT_1024), "proj", true);
    expect(isCollapsed(p, "proj", true)).toBe(true);
  });

  it("leaving the width and coming back forgets the override, even when nothing rendered in between", () => {
    // 1024 → reopen both → 1440 → 1024, applied back to back the way two
    // matchMedia change events land in one batch. No commit at 1440 is needed
    // to notice the change.
    let p = applyShed(INITIAL_POLICY, AT_1024);
    p = applyOverride(applyOverride(p, "proj", true), "task", true);
    p = applyShed(applyShed(p, AT_1440), AT_1024);
    expect(isCollapsed(p, "proj", false)).toBe(true);
    expect(isCollapsed(p, "task", false)).toBe(true);
    expect(p.reopened).toEqual({});
  });

  it("narrowing further drops the override too — the shed set is different", () => {
    let p = applyOverride(applyShed(INITIAL_POLICY, AT_1024), "proj", true);
    p = applyShed(p, AT_800);
    expect(isCollapsed(p, "proj", false)).toBe(true);
    expect(isCollapsed(p, "rail", false)).toBe(true);
  });

  it("re-reading an unchanged width is the same value, so it re-renders nothing and keeps the override", () => {
    const p = applyOverride(applyShed(INITIAL_POLICY, AT_1024), "proj", true);
    expect(applyShed(p, { ...AT_1024 })).toBe(p);
  });

  it("labels the shed set for data-shed", () => {
    expect(shedLabel(AT_1440)).toBe("");
    expect(shedLabel(AT_1024)).toBe("proj task");
    expect(shedLabel(AT_800)).toBe("proj task rail");
  });
});
