import { NextResponse } from "next/server";
import { getTask, getProject } from "@/lib/store";
import { getDriver } from "@/lib/agents/registry";
import { visibleAgentCommands } from "@/lib/agentCommands";

export const dynamic = "force-dynamic";

// The slash commands this task's composer should offer, straight from the agent
// that would run them (AgentDriver.listCommands, cached driver-side with a short
// TTL, see lib/agents/claude/commands.ts). Read-only and cheap enough to call on
// a keystroke; the client fetches it the first time the user types "/".
//
// Calandria's own /clear is not in this list. It is a client-side action, not a
// prompt the agent expands, so the composer prepends it, and lib/agentCommands.ts
// drops the CLI's same-named command so one name does not mean two things.
//
// Best-effort: a driver without a command surface (Codex) or a CLI that does not
// answer yields [], and the menu falls back to Calandria's own commands instead
// of erroring mid-typing.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(task.project_id);
  if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

  const driver = getDriver(task.agent);
  if (!driver.listCommands) return NextResponse.json({ commands: [] });

  try {
    const commands = await driver.listCommands(task, project);
    // no-store: the driver already caches with a TTL it controls, and a stale
    // browser or proxy copy could outlive a plugin the user just installed.
    return NextResponse.json(
      { commands: visibleAgentCommands(commands) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ commands: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}
