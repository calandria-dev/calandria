import { NextResponse } from "next/server";
import { getSettings, setSetting } from "@/lib/store";
import { publishGlobal } from "@/lib/events";

export const dynamic = "force-dynamic";

// App-level preferences that must be readable server-side (the per-task run
// controls fall back to these when a task hasn't overridden them). The run
// defaults are agent-scoped ("default_reasoning:<agent>") so each agent carries
// its own defaults; the legacy un-suffixed keys are still accepted for
// back-compat. `default_model` is agent-scoped only: a model id names one
// provider's catalog, so an un-scoped one could never be right for every
// driver, and there's no legacy key to honor. Its value is unvalidated here,
// like tasks.model: the catalog is instance config (a Vertex/Bedrock instance
// offers different ids), and the driver degrades an unknown id to its own
// default. `default_agent` is the app-wide default agent for new tasks;
// `utility_agent` is the agent that runs project-scoped internal one-shots
// (recaps, context drafts; see lib/agents/oneshots.ts), default "claude".
// `background_jobs` defaults to "on" and gates unattended agent turns;
// `recap_mode` defaults to "automatic" (also accepts "on_open" and "off").
// `job_model_light:<agent>` / `job_model_heavy:<agent>` pick the model for the
// internal one-shots, split by how hard the job is (light = the text-only
// handoff notes and recaps, heavy = the repo-exploring context draft; see
// lib/agents/oneshots.ts). Agent-scoped and unvalidated for the same reasons as
// `default_model`; unset means "inherit the driver's own default".
// The notify_* keys and their master switch (`notifications`) gate
// lib/notifications, enforced server-side because the webhook channel planned
// next must obey the same policy. All default on. `notify_queued_start` and
// `notify_queued_start_skipped` cover the two outcomes of a deadline coming
// due in lib/deferredStart.ts, which is the sweep `auto_resume_on_limit`
// below feeds.
// `plan_usage:<agent>` is display-only, "off" hiding that agent's titlebar
// usage tracker; it lives here instead of browser storage so the choice
// follows the instance to every device it's opened from, like every other
// preference on this route.
// `auto_resume_on_limit:<agent>` is "on" or unset: when a turn dies on that
// agent's spent quota, the runner queues the resume for the reset itself
// instead of waiting for a click on the transcript notice (lib/usageReset.ts,
// lib/deferredStart.ts). Off by default, since an unattended resume spends the
// next window's quota on whichever task happened to fail.
// `update_check` is "off" or unset and switches the release check off for this
// instance; `update_dismissed` holds the version somebody pressed "Skip this
// version" on, which hides the pill until something newer than it appears.
// The check's own result rides `update_state`. The server writes that key and
// this allowlist omits it, so no browser can overwrite the cache.
const ALLOWED = /^(background_jobs|recap_mode|notifications|notify_awaiting_input|notify_turn_failed|notify_schedule_failed|notify_queued_start|notify_queued_start_skipped|default_agent|utility_agent|update_check|update_dismissed|default_reasoning(:[a-z0-9_-]+)?|default_permission_mode(:[a-z0-9_-]+)?|default_model:[a-z0-9_-]+|job_model_(light|heavy):[a-z0-9_-]+|plan_usage:[a-z0-9_-]+|auto_resume_on_limit:[a-z0-9_-]+)$/;

/** The two keys the update pill re-reads when another tab writes them. */
const UPDATE_KEYS = new Set(["update_check", "update_dismissed"]);

export async function GET() {
  return NextResponse.json(getSettings());
}

export async function PATCH(req: Request) {
  const body = (await req.json()) as Record<string, string | null>;
  let updates = false;
  for (const k of Object.keys(body)) {
    if (!ALLOWED.test(k)) continue;
    setSetting(k, body[k]);
    if (UPDATE_KEYS.has(k)) updates = true;
  }
  // The pill is instance-wide, so a skip or a switch here has to reach the
  // other tabs. One event for the whole write, whichever of the two moved.
  if (updates) publishGlobal("", { type: "updates_changed" });
  return NextResponse.json(getSettings());
}
