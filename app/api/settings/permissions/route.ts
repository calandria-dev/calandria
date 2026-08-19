import { NextResponse } from "next/server";
import { addPermissionRule, deletePermissionRule, getProject, listAllPermissionRules, listProjectsPlain } from "@/lib/store";
import { ruleFromTypedCommand } from "@/lib/permissions";
import type { PermissionMatchKind } from "@/lib/types";

export const dynamic = "force-dynamic";

// The "always allow" grants for tool calls (lib/permissions.ts), listed for
// review, revocation — and creation — in Settings. A grant nobody can find is a
// grant nobody can take back, which is why the list exists; POST is the other
// gap: until it, a rule could only be minted by sitting through one prompt in
// one task, which an unattended turn auto-denies before anyone sees it.
//
// Each rule is returned with its project's name so the list reads without a
// second fetch; rules are project-scoped and cascade-delete with the project.
// The project roster rides along because the add form needs somewhere to scope
// a new rule TO — the panel has no project selected the way a transcript does.
export async function GET() {
  const projects = listProjectsPlain().map((p) => ({ id: p.id, name: p.name }));
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const rules = listAllPermissionRules().map((r) => ({ ...r, project_name: names.get(r.project_id) ?? "(deleted project)" }));
  return NextResponse.json({ rules, projects });
}

const MATCH_KINDS: PermissionMatchKind[] = ["bash_prefix", "bash_exact"];

/**
 * Add a rule by hand. Everything about WHAT may be granted is decided by
 * ruleFromTypedCommand() — the same prefix policy the permission card's
 * "Always allow" runs on — so this route only checks that the request names a
 * real project and a match kind it understands. It stores the value the policy
 * returns, not the text that was typed, and reports a refused prefix as a 400.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    project_id?: string;
    command?: string;
    match_kind?: string;
    tool?: string;
  };

  // Bash-only by design (see lib/permissions.ts): a rule naming anything else
  // can never match a call, so accepting one would store a grant-shaped no-op.
  if (body.tool != null && body.tool !== "Bash")
    return NextResponse.json({ error: "Remembered approvals only cover Bash commands." }, { status: 400 });

  if (!body.project_id) return NextResponse.json({ error: "project_id is required" }, { status: 400 });
  if (!getProject(body.project_id))
    return NextResponse.json({ error: "That project no longer exists." }, { status: 404 });

  const matchKind = body.match_kind as PermissionMatchKind;
  if (!MATCH_KINDS.includes(matchKind))
    return NextResponse.json({ error: "match_kind must be bash_prefix or bash_exact." }, { status: 400 });

  const drafted = ruleFromTypedCommand(body.command ?? "", matchKind);
  if (!drafted.ok) return NextResponse.json({ error: drafted.error }, { status: 400 });

  const rule = addPermissionRule({
    project_id: body.project_id,
    tool: drafted.tool,
    match_kind: drafted.match_kind,
    value: drafted.value,
  });
  return NextResponse.json({ rule: { ...rule, project_name: getProject(body.project_id)!.name } });
}

export async function DELETE(req: Request) {
  const { id } = (await req.json()) as { id?: string };
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  deletePermissionRule(id);
  return NextResponse.json({ ok: true });
}
