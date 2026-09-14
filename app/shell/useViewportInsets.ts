"use client";

import { useEffect } from "react";
import { isTextEntryElement, keyboardInset, scrollOffsetIsStale, shellViewportHeight } from "./viewport";
import { recordLifecycleEvent } from "./useLifecycleDiagnostics";

// The custom properties the phone layout reads. globals.css uses the inset for
// scrims and home-indicator padding, and the measured height for the shell and
// modals; keep these names in step with it.
export const KB_INSET_VAR = "--kb-inset";
export const VIEWPORT_HEIGHT_VAR = "--viewport-height";

// How long after a resume to re-measure. WebKit restores the page and then
// settles the viewport, so the value read inside the visibilitychange handler
// can still be the stale one; a frame and a beat later it is not.
const SETTLE_MS = 300;

/**
 * Publishes the on-screen keyboard's overlap as --kb-inset and the measured
 * shell height as --viewport-height on <html>, and puts back any document
 * scroll offset WebKit applied to clear a focused field.
 *
 * The two viewport properties cover both browser models: iOS shrinks only the
 * visual viewport, while other engines shrink the layout viewport too. The
 * measured height prevents CSS from subtracting the keyboard twice. Without
 * the scroll reset the offset can outlive the keyboard and leave the installed
 * app painted too high to reach its back button.
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
      const metrics = {
        layoutHeight: window.innerHeight,
        visualHeight: vv?.height ?? window.innerHeight,
        visualOffsetTop: vv?.offsetTop ?? 0,
        scale: vv?.scale ?? 1,
        fieldFocused: isTextEntryElement(document.activeElement as HTMLInputElement | null),
      };
      const inset = keyboardInset(metrics);
      root.style.setProperty(KB_INSET_VAR, `${inset}px`);
      root.style.setProperty(VIEWPORT_HEIGHT_VAR, `${shellViewportHeight(metrics)}px`);
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
      root.style.removeProperty(VIEWPORT_HEIGHT_VAR);
    };
  }, [enabled]);
}
