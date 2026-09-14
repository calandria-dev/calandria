import { describe, expect, it } from "vitest";
import { KEYBOARD_MIN_INSET, isTextEntryElement, keyboardInset, scrollOffsetIsStale, type ViewportMetrics } from "../app/shell/viewport";

// An iPhone 16 Pro Max in portrait: 440x956 CSS px, home indicator inset 34.
const LAYOUT_HEIGHT = 956;

// A field is focused and the page is unzoomed unless a case says otherwise.
function metrics(p: Partial<ViewportMetrics>): ViewportMetrics {
  return { layoutHeight: LAYOUT_HEIGHT, visualHeight: LAYOUT_HEIGHT, visualOffsetTop: 0, scale: 1, fieldFocused: true, ...p };
}

describe("keyboardInset: what the on-screen keyboard covers", () => {
  it("is 0 with no keyboard, where the two viewports agree", () => {
    expect(keyboardInset(metrics({}))).toBe(0);
  });

  it("is the keyboard's height when iOS shrinks the visual viewport alone", () => {
    // The layout viewport does not move, so 100dvh is still 956 and only this
    // difference tells the shell the keyboard is there.
    expect(keyboardInset(metrics({ visualHeight: 620 }))).toBe(336);
  });

  it("counts the scroll WebKit applied to clear the focused field, not just the shrink", () => {
    // Same keyboard, but the page was pushed up 50px to reveal the composer.
    // The overlap below the visible strip is what is left to give back.
    expect(keyboardInset(metrics({ visualHeight: 620, visualOffsetTop: 50 }))).toBe(286);
  });

  it("ignores drift smaller than any real keyboard", () => {
    expect(keyboardInset(metrics({ visualHeight: LAYOUT_HEIGHT - 1 }))).toBe(0);
    expect(keyboardInset(metrics({ visualHeight: LAYOUT_HEIGHT - (KEYBOARD_MIN_INSET - 1) }))).toBe(0);
    expect(keyboardInset(metrics({ visualHeight: LAYOUT_HEIGHT - KEYBOARD_MIN_INSET }))).toBe(KEYBOARD_MIN_INSET);
  });

  it("reports no keyboard while the user is pinch-zoomed", () => {
    // Zooming shrinks the visual viewport for a reason of the user's own, and
    // shrinking the shell to match would fight it.
    expect(keyboardInset(metrics({ visualHeight: 478, visualOffsetTop: 200, scale: 2 }))).toBe(0);
  });

  it("reports no keyboard with nothing focused, which is WebKit 323322's phantom inset", () => {
    // A resumed iOS app can be handed a keyboard-sized visualViewport inset
    // with no keyboard behind it. Nothing raises one without a field to type
    // into, so the focus check is what tells the two apart.
    expect(keyboardInset(metrics({ visualHeight: 620, fieldFocused: false }))).toBe(0);
  });

  it("rounds, so a fractional scroll does not rewrite the property every frame", () => {
    expect(keyboardInset(metrics({ visualHeight: 620.4, visualOffsetTop: 0.2 }))).toBe(335);
  });

  it("is 0 where the browser resizes the layout viewport for the keyboard instead", () => {
    // Both viewports shrink together, so 100dvh already excludes the keyboard.
    expect(keyboardInset(metrics({ layoutHeight: 620, visualHeight: 620 }))).toBe(0);
  });
});

describe("isTextEntryElement: what a keyboard can be up for", () => {
  it("accepts the composer's contenteditable and a textarea", () => {
    expect(isTextEntryElement({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTextEntryElement({ tagName: "TEXTAREA" })).toBe(true);
  });

  it("accepts the text-entry input types and an input with no type at all", () => {
    for (const type of ["text", "search", "email", "url", "number", "password"]) {
      expect(isTextEntryElement({ tagName: "INPUT", type })).toBe(true);
    }
    expect(isTextEntryElement({ tagName: "INPUT" })).toBe(true);
  });

  it("rejects controls that raise no keyboard, and an unfocused page", () => {
    expect(isTextEntryElement({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextEntryElement({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isTextEntryElement({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntryElement({ tagName: "BODY", isContentEditable: false })).toBe(false);
    expect(isTextEntryElement(null)).toBe(false);
  });
});

describe("scrollOffsetIsStale: the shell's document never means to be scrolled", () => {
  it("is false at the origin", () => {
    expect(scrollOffsetIsStale(0, 0)).toBe(false);
  });

  it("is true for the offset a resumed iOS app comes back holding", () => {
    expect(scrollOffsetIsStale(0, 96)).toBe(true);
    expect(scrollOffsetIsStale(12, 0)).toBe(true);
  });
});
