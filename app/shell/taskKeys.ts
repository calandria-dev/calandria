// Single-key task navigation (handoff States: j/k move, enter open,
// t terminal, d diff, n new). Pure so tests/taskKeys.test.ts can drive it
// without a DOM; the shell owns the keydown listener and the effects.

export type TaskKeyAction = "next" | "prev" | "open" | "terminal" | "diff" | "new";

const KEYS: Record<string, TaskKeyAction> = {
  j: "next", k: "prev", Enter: "open", t: "terminal", d: "diff", n: "new",
};

// Anything that takes typed text: form fields, contenteditable, CodeMirror
// and xterm (whose hidden helper textarea also matches, but the container
// check covers a focused viewport too).
const TYPING = "input, textarea, select, [contenteditable]:not([contenteditable='false']), .cm-editor, .xterm, .term-host";

const CONTROL = "button, a[href], [role='button'], summary";

type TargetLike = { isContentEditable?: boolean; closest?: (sel: string) => unknown };

// True when the event target (an Element, or null for the page body) sits
// inside anything matching `sel`.
function within(target: unknown, sel: string): boolean {
  const t = target as TargetLike | null;
  return typeof t?.closest === "function" && !!t.closest(sel);
}

export function isTypingTarget(target: unknown): boolean {
  if ((target as TargetLike | null)?.isContentEditable) return true;
  return within(target, TYPING);
}

type KeyLike = {
  key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
  isComposing?: boolean; defaultPrevented?: boolean; target: unknown;
};

// The action a keydown maps to, or null when it isn't ours: any modifier
// held, an IME composition, a handler upstream already took it, or focus is
// somewhere text goes.
export function taskKeyAction(e: KeyLike): TaskKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.isComposing || e.defaultPrevented) return null;
  const action = KEYS[e.key];
  if (!action) return null;
  if (isTypingTarget(e.target)) return null;
  // Enter on a focused control belongs to that control. A focused task card
  // handles its own Enter and marks the event handled.
  if (action === "open" && within(e.target, CONTROL)) return null;
  return action;
}

// The id j/k lands on, walking the on-screen order. Starts from `from` (the
// focused or selected task); with nothing to start from, j picks the first
// and k the last. Clamps at both ends.
export function stepTask(ids: string[], from: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const i = from ? ids.indexOf(from) : -1;
  if (i < 0) return dir === 1 ? ids[0] : ids[ids.length - 1];
  return ids[Math.min(ids.length - 1, Math.max(0, i + dir))];
}
