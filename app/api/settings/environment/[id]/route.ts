import { NextResponse } from "next/server";

import { requestFromBrowser } from "@/lib/advanced-env/browserAuth";
import { deleteVariable, patchVariable } from "@/lib/advanced-env/store";
import type { StoreFailure } from "@/lib/advanced-env/store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(result: StoreFailure) {
  return NextResponse.json({ error: result.reason, code: result.code, currentRevision: result.currentRevision }, { status: result.status, headers: NO_STORE });
}

/**
 * Edit one variable. An omitted name or value keeps the stored one, so a
 * secret can be renamed or have its flag changed with no way to read the old
 * value back. An empty string is a real replacement value. A null field is
 * refused instead of being read as "keep", since the two are different asks
 * and guessing wrong would silently discard a value.
 */
export async function PATCH(req: Request, { params }: RouteContext) {
  const guard = requestFromBrowser(req);
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: 403, headers: NO_STORE });
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    name?: unknown;
    value?: unknown;
    secret?: unknown;
    expectedRevision?: unknown;
    confirmExpose?: unknown;
  };

  if ("name" in body && body.name !== undefined && typeof body.name !== "string")
    return NextResponse.json({ error: "name must be a string." }, { status: 400, headers: NO_STORE });
  if ("value" in body && body.value !== undefined && typeof body.value !== "string")
    return NextResponse.json({ error: "value must be a string." }, { status: 400, headers: NO_STORE });
  if ("secret" in body && body.secret !== undefined && typeof body.secret !== "boolean")
    return NextResponse.json({ error: "secret must be a boolean." }, { status: 400, headers: NO_STORE });
  if (!Number.isInteger(body.expectedRevision))
    return NextResponse.json({ error: "expectedRevision is required." }, { status: 400, headers: NO_STORE });

  const result = patchVariable(id, {
    name: body.name as string | undefined,
    value: body.value as string | undefined,
    secret: body.secret as boolean | undefined,
    expectedRevision: body.expectedRevision as number,
    confirmExpose: body.confirmExpose === true,
  });
  if (!result.ok) return refuse(result);
  return NextResponse.json({ row: result.row, revision: result.revision }, { headers: NO_STORE });
}

/** Remove the saved override. The inherited or default value applies again. */
export async function DELETE(req: Request, { params }: RouteContext) {
  const guard = requestFromBrowser(req);
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: 403, headers: NO_STORE });
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as { expectedRevision?: unknown };
  if (!Number.isInteger(body.expectedRevision))
    return NextResponse.json({ error: "expectedRevision is required." }, { status: 400, headers: NO_STORE });

  const result = deleteVariable(id, { expectedRevision: body.expectedRevision as number });
  if (!result.ok) return refuse(result);
  return NextResponse.json({ revision: result.revision }, { headers: NO_STORE });
}
