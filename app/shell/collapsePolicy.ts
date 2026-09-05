// The auto-collapse policy's state, kept pure (no React, no window). The
// invariant: a spine's "show it anyway" override is granted at a specific
// shed set, and is void the moment the shed set changes. Both facts live in
// one value, and the override is dropped in the same update that replaces
// the shed set, so the rendered result is a function of the current state
// alone with no transition to track separately.
//
// A width the browser never reported cannot be fixed by any state shape:
// matchMedia fires once per rendered frame, so a resize undone before a
// frame runs is invisible to the app. That is a fact for whoever drives the
// window (the e2e suite waits on `data-shed`, the label below, before
// asserting on a return leg), not for this module.
//
// Thresholds live in AUTO_COLLAPSE_BELOW (types.ts); reading the window is the
// hook's job (useAutoCollapse in app/Shell.tsx).

export type Col = "proj" | "task" | "rail";

export type ShedSet = Record<Col, boolean>;

export interface CollapsePolicy {
  /** Which columns the window is currently too narrow to keep open. */
  shed: ShedSet;
  /**
   * Columns the user reopened from their spine (true) or re-collapsed (false)
   * at THIS shed set. Absent = the policy decides.
   */
  reopened: Partial<Record<Col, boolean>>;
}

export const COLS: readonly Col[] = ["proj", "task", "rail"];

export const NOTHING_SHED: ShedSet = { proj: false, task: false, rail: false };

export const INITIAL_POLICY: CollapsePolicy = { shed: NOTHING_SHED, reopened: {} };

export const sameShed = (a: ShedSet, b: ShedSet): boolean => COLS.every((c) => a[c] === b[c]);

/**
 * The window's shed set was (re)read. An unchanged set returns the same object,
 * so a resize that crossed no threshold re-renders nothing; a changed one
 * replaces the set AND forgets every override, in one value.
 */
export function applyShed(p: CollapsePolicy, shed: ShedSet): CollapsePolicy {
  return sameShed(p.shed, shed) ? p : { shed, reopened: {} };
}

/** The user clicked a spine (open = true) or collapsed a column (open = false). */
export function applyOverride(p: CollapsePolicy, col: Col, open: boolean): CollapsePolicy {
  return { ...p, reopened: { ...p.reopened, [col]: open } };
}

/**
 * Whether a column shows as its spine right now: the user's own persisted
 * collapse always wins; otherwise the policy sheds it unless it was reopened at
 * this very shed set.
 */
export function isCollapsed(p: CollapsePolicy, col: Col, userCollapsed: boolean): boolean {
  return userCollapsed || (p.shed[col] && !p.reopened[col]);
}

/**
 * The shed set as a space-separated list ("proj task", or "" when nothing is
 * shed): what the shell writes to `data-shed`. It is the policy's one
 * observable: a reopened column at 1024 and an untouched one at 1440 render
 * the same DOM, so this is how anything outside the app (the e2e suite, a
 * stylesheet) learns which width the app has actually seen.
 */
export const shedLabel = (shed: ShedSet): string => COLS.filter((c) => shed[c]).join(" ");
