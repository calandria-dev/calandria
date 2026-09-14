"use client";

import { useEffect } from "react";
import { isTextEntryElement, keyboardInset, scrollOffsetIsStale } from "./viewport";
import { recordLifecycleEvent } from "./useLifecycleDiagnostics";

// The custom property the phone layout reads. globals.css subtracts it from
// the shell's height and from the composer's home-indicator padding; keep the
// two in step with this name.
export const KB_INSET_VAR = "--kb-inset";

// How long after a resume to re-measure. WebKit restores the page and then
// settles the viewport, so the value read inside the visibilitychange handler
// can still be the stale one; a frame and a beat later it is not.
const SETTLE_MS = 300;

/**
 * Publishes the on-screen keyboard's overlap as --kb-inset on <html>, and puts
 * back any document scroll offset WebKit applied to clear a focused field.
 *
 * Both halves exist because iOS shrinks the visual viewport for the keyboard
 * and leaves the layout viewport alone (see viewport.ts). Without the inset
 * the shell stays full height under the keyboard, so the composer floats above
 * a strip of dead space; without the scroll reset the offset can outlive the
 * keyboard and leave the installed app painted too high to reach its back
 * button.
 *
 * Phone-only: the desktop layout has no keyboard to dodge, and leaving the
 * property unset there keeps every var() on its 0 fallback.
 */
export function useViewportInsets(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const vv = window.visualViewport;

    // `record` only on the resume path: that is the offset worth a diagnostic
    // line, and it happens once, where a keyboard opening reports dozens of
    // viewport events a second and would fill the log with them.
    const apply = (record: boolean) => {
      const inset = vv
        ? keyboardInset({
            layoutHeight: window.innerHeight,
            visualHeight: vv.height,
            visualOffsetTop: vv.offsetTop,
            scale: vv.scale,
            fieldFocused: isTextEntryElement(document.activeElement as HTMLInputElement | null),
          })
        : 0;
      root.style.setProperty(KB_INSET_VAR, `${inset}px`);
      // Written after the inset, so the shell is already sized to the visible
      // viewport and the focused field stays on screen without the offset.
      if (!scrollOffsetIsStale(window.scrollX, window.scrollY)) return;
      if (record) recordLifecycleEvent({ kind: "scroll_reset", scrollY: Math.round(window.scrollY) });
      window.scrollTo(0, 0);
    };

    const track = () => apply(false);
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      apply(true);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => apply(true));
      clearTimeout(timer);
      timer = setTimeout(() => apply(true), SETTLE_MS);
    };

    track();
    vv?.addEventListener("resize", track);
    vv?.addEventListener("scroll", track);
    // Focus moving is not a viewport change, so nothing above would fire for
    // it, and the inset is only ever real while a text field holds focus.
    document.addEventListener("focusin", track);
    document.addEventListener("focusout", track);
    window.addEventListener("resize", settle);
    window.addEventListener("orientationchange", settle);
    window.addEventListener("pageshow", settle);
    document.addEventListener("visibilitychange", settle);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      vv?.removeEventListener("resize", track);
      vv?.removeEventListener("scroll", track);
      document.removeEventListener("focusin", track);
      document.removeEventListener("focusout", track);
      window.removeEventListener("resize", settle);
      window.removeEventListener("orientationchange", settle);
      window.removeEventListener("pageshow", settle);
      document.removeEventListener("visibilitychange", settle);
      root.style.removeProperty(KB_INSET_VAR);
    };
  }, [enabled]);
}
