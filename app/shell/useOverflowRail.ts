"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Progressive collapse for a one-line control rail (the session header's
 * `.sh-tools`).
 *
 * A single breakpoint can't answer this. The pane the rail sits in runs from a
 * 390px phone through a dragged-narrow middle column to a full-width desktop,
 * and the rail's own content changes width with it (a PR chip appears, a model
 * label goes from "Inherit" to "Claude Opus 4.6 (1M)"). So the rail measures
 * itself: everything renders, and the caller drops its lowest-priority items
 * one at a time — behind a "More" toggle — until what's left fits.
 *
 * Returns how many of the caller's `droppable` items must come off the rail.
 *
 * Two properties matter and neither is free:
 *
 * - **It converges.** Hiding an item changes the layout, which re-runs the
 *   measurement, which may hide another. The effect re-runs on the count it
 *   just set, so the walk happens across renders and stops at the first fit.
 * - **It doesn't oscillate.** Growing back can't key on "there's slack now",
 *   because the slack exists *because* something is hidden — restoring it would
 *   overflow, hide it again, and flicker forever. Instead every failure records
 *   the HOST width it happened at (`failAt`), and an item comes back only once
 *   the host is genuinely wider than that. The host is the rail's parent rather
 *   than the rail itself: a rail that hugs its content reports the same width
 *   whether the pane has 10px of room left or 500px.
 *
 * `signature` is the caller's summary of what it is rendering — the rendered
 * labels, not the values behind them, so it moves when the rail's width can.
 *
 * `enabled` is false while the rail is expanded into wrapped rows, where there
 * is no overflow to read and the answer would collapse to zero.
 */
export function useOverflowRail(
  ref: RefObject<HTMLElement | null>,
  droppable: number,
  signature: string,
  enabled: boolean,
): number {
  const [hidden, setHidden] = useState(0);
  // Mirrors `hidden` for the ResizeObserver callback, which closes over the
  // render it was created in and would otherwise step from a stale count.
  const hiddenRef = useRef(0);
  const failAt = useRef(new Map<number, number>());

  // A new signature retires every recorded width, since they describe a rail
  // that no longer exists. It does NOT reset the count: dropping back to "show
  // everything" and re-collapsing would paint one overflowing frame, and this
  // fires whenever a label changes — the usage chip's own numbers move mid-turn.
  // Clearing the record is enough, because growing back is what the record
  // gates; the walk below then re-converges from where it is, one item per
  // measurement, without the DOM ever being seen mid-walk.
  useEffect(() => {
    failAt.current.clear();
    if (hiddenRef.current > droppable) {
      hiddenRef.current = droppable;
      setHidden(droppable);
    }
  }, [signature, droppable]);

  const measureRef = useRef<() => void>(() => {});
  measureRef.current = () => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host || !enabled) return;
    const w = host.clientWidth;
    // scrollWidth and clientWidth are integers; a sub-pixel overhang from a
    // fractional gap is not an overflow.
    const over = el.scrollWidth - el.clientWidth > 1;
    const h = hiddenRef.current;
    const onRail = droppable - h;
    if (over) {
      if (h >= droppable) return; // nothing droppable left; the pinned set is the floor
      failAt.current.set(onRail, w);
      hiddenRef.current = h + 1;
      setHidden(h + 1);
      return;
    }
    if (h > 0) {
      const failed = failAt.current.get(onRail + 1);
      if (failed === undefined || w > failed) {
        hiddenRef.current = h - 1;
        setHidden(h - 1);
      }
    }
  };

  // Re-measure after every change to the count we just set, which is what walks
  // the collapse down to a fit. Layout effect, so the intermediate states are
  // resolved before the browser paints and no half-collapsed rail is ever seen.
  useLayoutEffect(() => { measureRef.current(); }, [hidden, droppable, signature, enabled]);

  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const ro = new ResizeObserver(() => measureRef.current());
    ro.observe(host);
    return () => ro.disconnect();
  }, [ref]);

  return Math.min(hidden, droppable);
}
