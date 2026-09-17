"use client";

/**
 * The affordance attached to the idle mark (./idleTurn.ts): Stop, on a card,
 * behind a confirm.
 *
 * Why it confirms: `lib/turnActivity.ts` cannot tell a wedged wait from a
 * slow one, so the mark itself never stops anything. A one-click Stop on a
 * card risks a mis-aim instead: the list and the board are dense, a card is
 * clicked to select it, and the cost of a wrong press is real work thrown
 * away with no undo. So the first press arms, and a second press commits. It
 * disarms itself after ARM_MS, since a chip left armed in a scrolling list
 * risks the same mis-aim the confirm guards against; re-arming costs one more
 * click.
 *
 * Why the session view does not get one: the composer's Stop is already
 * visible for the whole of a live turn, including a linger, with the
 * transcript there to judge against, so it needs no confirm. A second Stop in
 * that view would duplicate the composer's under a different policy. The gap
 * the mark leaves open is on the list and the board, where acting on it means
 * selecting the task first; that is where this control lives.
 */

import { useEffect, useState } from "react";
import { Icon } from "../icons";

/**
 * How long an armed confirm stays armed. Long enough to read the line and
 * decide, short enough that a card scrolled past and forgotten is back to
 * needing two presses.
 */
const ARM_MS = 6000;

/**
 * Not IDLE_TITLE, which describes the mark. This describes the button,
 * including the two facts that decide whether to press it: nothing here can
 * tell a stall from a slow tool call, and a stopped turn keeps its partial
 * transcript and resumes on the next message, so stopping is recoverable but
 * not free.
 */
const STOP_TITLE =
  "Stop this turn now. Nothing here can tell a stalled wait from a slow one, so this asks before it acts. A stopped turn keeps what it has already written and picks back up when you send it a message.";

export function IdleStopChip({ variant, onStop }: { variant: "list" | "board"; onStop: () => void }) {
  const [armed, setArmed] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  // The chip borrows its host card's chip shape, the list's pill or the
  // board's box, so it reads as one of the row's states.
  const base = variant === "list" ? "idle-chip" : "bc-chip idle";
  // Every handler stops propagation: the card underneath is an
  // <article role="button"> whose click SELECTS the task, and arming a confirm
  // must not also navigate.
  if (stopping) return <div className={`${base} armed`}>{Icon.stop()} Stopping…</div>;
  if (!armed) {
    return (
      <button type="button" className={base} title={STOP_TITLE}
        onClick={(e) => { e.stopPropagation(); setArmed(true); }}>
        {Icon.stop()} Stop this turn
      </button>
    );
  }
  return (
    <div className={`${base} armed`} title={STOP_TITLE} onClick={(e) => e.stopPropagation()}>
      {/* The confirm states the ambiguity directly instead of relying on the
          tooltip, which a card click never triggers. */}
      <span>Stop it? A long build looks the same.</span>
      <button type="button" className="idle-btn" onClick={(e) => { e.stopPropagation(); setArmed(false); }}>Cancel</button>
      <button type="button" className="idle-btn" onClick={(e) => { e.stopPropagation(); setStopping(true); onStop(); }}>Stop</button>
    </div>
  );
}
