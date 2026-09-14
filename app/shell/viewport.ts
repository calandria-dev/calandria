// Viewport arithmetic for the phone surface. The pure half of
// useViewportInsets.ts, pinned by tests/viewport.test.ts.
//
// iOS resizes only the VISUAL viewport for the on-screen keyboard. The layout
// viewport keeps its full height, so 100dvh, 100vh and env(safe-area-inset-*)
// all read exactly as they did before the keyboard opened, and no CSS query
// can see it. What does change is window.visualViewport: its height shrinks by
// the keyboard and its offsetTop carries however far WebKit scrolled the page
// to keep the focused field on screen. The difference between the two
// viewports is the number the layout needs.

// Below this an overlap is not a keyboard. The shortest software keyboard is
// several hundred CSS pixels tall, while a settling page reports a pixel or
// two of drift, and restyling the whole shell for that would flicker it.
export const KEYBOARD_MIN_INSET = 60;

// The input types that raise a keyboard, matching the :has() selector the
// phone block in globals.css hides the tab bar on; keep the two in step.
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "number", "password"]);

/** Whether this element is something the user types into, so a keyboard can be up for it. */
export function isTextEntryElement(el: { tagName?: string; type?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  return TEXT_INPUT_TYPES.has((el.type ?? "text").toLowerCase());
}

export interface ViewportMetrics {
  /** window.innerHeight: the layout viewport, which the keyboard does not change. */
  layoutHeight: number;
  /** visualViewport.height: what the user can actually see. */
  visualHeight: number;
  /** visualViewport.offsetTop: how far the visible part sits down the layout viewport. */
  visualOffsetTop: number;
  /** visualViewport.scale: 1 unless the user has pinch-zoomed. */
  scale: number;
  /** Whether a text field holds focus, from isTextEntryElement. */
  fieldFocused: boolean;
}

/**
 * How many CSS pixels of the layout viewport the on-screen keyboard covers, 0
 * when there is no keyboard. Published as the --kb-inset custom property and
 * subtracted from the shell's height, which puts the composer against the keys
 * instead of floating above a strip of dead space.
 *
 * Two shrinks that are not a keyboard are screened out. A pinch-zoom shrinks
 * the visual viewport too, and shrinking the shell to match would fight the
 * user's zoom. And WebKit 323322 hands a resumed iOS app a phantom
 * keyboard-sized inset with no keyboard behind it; nothing raises a keyboard
 * without a text field to type into, so an unfocused page reports none.
 */
export function keyboardInset(m: ViewportMetrics): number {
  if (!m.fieldFocused || m.scale > 1.01) return 0;
  const overlap = Math.round(m.layoutHeight - m.visualHeight - m.visualOffsetTop);
  return overlap >= KEYBOARD_MIN_INSET ? overlap : 0;
}

/**
 * Whether the document carries a scroll offset that has to be put back.
 *
 * The shell is a fixed-height surface and html/body are overflow:hidden, so
 * the document's own scroll offset is always meant to be 0. WebKit ignores
 * that when it scrolls a focused field clear of the keyboard, and on the
 * installed iOS app the offset can outlive the keyboard that caused it: the
 * app comes back from the background painted a hundred pixels too high, with
 * the titlebar and its back button pushed off the top, and nothing but a
 * force-quit puts it right. Undoing the offset is the recovery.
 */
export function scrollOffsetIsStale(scrollX: number, scrollY: number): boolean {
  return scrollX !== 0 || scrollY !== 0;
}
