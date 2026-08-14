import { NextResponse } from "next/server";
import { deletePermissionRule, listAllPermissionRules, listProjects } from "@/lib/store";

export const dynamic = "force-dynamic";

// The "always allow" answers the user has given tool-permission prompts
// (lib/permissions.ts), listed for review and revocation in Settings. A grant
// nobody can find is a grant nobody can take back, which is the whole reason
// this route exists — the gate itself never needs it.
//
// Each rule is returned with its project's name so the list reads without a
// second fetch; rules are project-scoped and cascade-delete with the project.
export async function GET() {
  const names = new Map(listProjects().map((p) => [p.id, p.name]));
  const rules = listAllPermissionRules().map((r) => ({ ...r, project_name: names.get(r.project_id) ?? "(deleted project)" }));
  return NextResponse.json({ rules });
}

export async function DELETE(req: Request) {
  const { id } = (await req.json()) as { id?: string };
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  deletePermissionRule(id);
  return NextResponse.json({ ok: true });
}
