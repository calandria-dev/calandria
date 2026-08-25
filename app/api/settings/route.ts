import { NextResponse } from "next/server";
import { getSettings, setSetting } from "@/lib/store";

export const dynamic = "force-dynamic";

// App-level preferences that must be readable server-side (the per-task run
// controls fall back to these when a task hasn't overridden them). The run
// defaults are agent-scoped ("default_reasoning:<agent>") so each agent carries
// its own defaults; the legacy un-suffixed keys are still accepted for
// back-compat. `default_model` is agent-scoped ONLY — a model id names one
// provider's catalog, so an un-scoped one could never be right for every
// driver, and there's no legacy key to honor. Its VALUE is unvalidated here,
// like tasks.model: the catalog is instance config (a Vertex/Bedrock instance
// offers different ids), and the driver degrades an id it doesn't know to its
// own default. `default_agent` is the app-wide default agent for new tasks;
// `utility_agent` is the agent that runs project-scoped internal one-shots
// (recaps, context drafts — see lib/agents/oneshots.ts), default "claude".
// `background_jobs` defaults to "on" and gates unattended agent turns;
// `recap_mode` defaults to "automatic" (also accepts "on_open" and "off").
// The notify_* keys and their master switch (`notifications`) gate
// lib/notifications — server-side rather than in the browser because the
// webhook channel planned next must obey the same policy. All default on.
const ALLOWED = /^(background_jobs|recap_mode|notifications|notify_awaiting_input|notify_turn_failed|notify_schedule_failed|default_agent|utility_agent|default_reasoning(:[a-z0-9_-]+)?|default_permission_mode(:[a-z0-9_-]+)?|default_model:[a-z0-9_-]+)$/;

export async function GET() {
  return NextResponse.json(getSettings());
}

export async function PATCH(req: Request) {
  const body = (await req.json()) as Record<string, string | null>;
  for (const k of Object.keys(body)) {
    if (ALLOWED.test(k)) setSetting(k, body[k]);
  }
  return NextResponse.json(getSettings());
}
