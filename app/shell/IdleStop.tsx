"use client";

/**
 * The one affordance attached to the idle mark (./idleTurn.ts): Stop, on a
 * card, behind a confirm.
 *
 * Two calls this file exists to record.
 *
 * WHY IT CONFIRMS. lib/turnActivity.ts cannot tell a wedged wait from a slow
 * one — a 40-minute Docker e2e run and a `pgrep` loop that self-matched its own
 * command line look identical from the server — which is the whole reason the
 * mark refuses to stop anything by itself. Giving that same undecidable signal
 * a ONE-CLICK Stop on a card would only move the bad call from the server to a
 * mis-aim: the list and the board are dense, a card is clicked to SELECT it, and
 * the cost of the wrong press is half an hour of real work thrown away with no
 * undo. So the first press arms, the armed state says the thing the mark can't
 * know, and a second press commits. It disarms itself after ARM_MS, because a
 * chip left armed in a scrolling list is exactly the mis-aim the confirm was
 * for; re-arming costs one more click and nothing else.
 *
 * WHY THE SESSION DOESN'T GET ONE. The composer's Stop is already there,
 * visible for the whole of a live turn (a linger included), a few hundred pixels
 * under the idle note, with the transcript in between to judge against — which
 * is the judgement this control can't offer and doesn't try to. A second Stop in
 * that view would be the same verb twice, and, since this one confirms and that
 * one doesn't, twice under two policies. The gap the mark left open is on the
 * LIST and the BOARD, where acting on it means selecting the task first. That is
 * the only place this goes.
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
 * Deliberately not IDLE_TITLE, which describes the MARK. This describes the
 * button, including the two facts that decide whether to press it: that nothing
 * here can tell a stall from a slow tool call, and what a stopped turn costs
 * (its partial transcript is kept and it resumes on the next message, so this
 * is recoverable — just not free).
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
  // The chip borrows its host card's chip shape so it reads as one of the row's
  // states rather than a control bolted on: the list's pill, the board's box.
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
      {/* The confirm carries the ambiguity itself rather than leaving it to the
          tooltip. A warning nobody hovers is not a warning. */}
      <span>Stop it? A long build looks the same.</span>
      <button type="button" className="idle-btn" onClick={(e) => { e.stopPropagation(); setArmed(false); }}>Cancel</button>
      <button type="button" className="idle-btn" onClick={(e) => { e.stopPropagation(); setStopping(true); onStop(); }}>Stop</button>
    </div>
  );
}
