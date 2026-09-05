import { nextCronFire, wakeTimeLabel } from "@/lib/agents/claude/sessionCrons";

/**
 * A one-shot session cron N minutes out, as the Stop hook reports it (wall-clock
 * minute only, server-local), plus the label the driver will print for it.
 *
 * The label is derived with the driver's own `nextCronFire` + `wakeTimeLabel`
 * rather than formatted as bare `HH:MM` here, because `wakeTimeLabel` prefixes
 * a weekday for a fire time that lands on a different calendar day than `now`.
 * Three suites hardcoded `HH:MM`, so any run that started within N minutes of
 * local midnight got `"Sat 00:03"` and failed — which is exactly what sank the
 * v0.9.0 tag build at 23:58 UTC. Formatting itself is pinned on a frozen clock
 * in `tests/sessionCrons.test.ts`; these suites only care that the notice names
 * THIS wakeup.
 */
export function oneShotIn(minutes: number, opts: { id?: string; prompt?: string } = {}): {
  cron: { id: string; schedule: string; recurring: false; prompt: string };
  when: string;
} {
  const now = Date.now();
  const d = new Date(now + minutes * 60_000);
  const schedule = `${d.getMinutes()} ${d.getHours()} * * *`;
  return {
    cron: { id: opts.id ?? "w1", schedule, recurring: false, prompt: opts.prompt ?? "WAKE: check the build" },
    when: wakeTimeLabel(nextCronFire(schedule, now), now),
  };
}
