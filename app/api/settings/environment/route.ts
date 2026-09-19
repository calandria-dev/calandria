import { NextResponse } from "next/server";

import { listEditableDescriptors } from "@/lib/advanced-env/catalog.mjs";
import { requestFromBrowser } from "@/lib/advanced-env/browserAuth";
import { createVariable, listEnvironment } from "@/lib/advanced-env/store";
import type { StoreFailure } from "@/lib/advanced-env/store";
import { INSTANCE_NAME } from "@/lib/config";

export const dynamic = "force-dynamic";

// Settings -> Advanced. The list is redacted before it leaves the server: a
// secret row carries neither its name nor its value, only an opaque id and the
// flags the table needs to draw a row and offer edit and delete.
//
// The catalog rides along so the add dialog can search it without a second
// fetch. It is static metadata with no live values in it, and which entries
// are already taken is computed on the client from the visible rows, so a
// secret row's name cannot be inferred from a server-marked selection.
const NO_STORE = { "Cache-Control": "no-store" };

function refuse(result: StoreFailure) {
  return NextResponse.json({ error: result.reason, code: result.code, currentRevision: result.currentRevision }, { status: result.status, headers: NO_STORE });
}

export async function GET(req: Request) {
  const view = listEnvironment();
  const host = req.headers.get("host") || "";
  return NextResponse.json(
    {
      rows: view.rows,
      revision: view.revision,
      restartRequired: view.restartRequired,
      loadError: view.loadError,
      catalog: listEditableDescriptors(),
      instance: { name: INSTANCE_NAME || host, host },
    },
    { headers: NO_STORE },
  );
}

/**
 * Add a variable. The same-origin guard is on every mutation here because
 * middleware's local mode admits a raw loopback client by design, and this
 * route edits what the server and its agent sessions run under.
 */
export async function POST(req: Request) {
  const guard = requestFromBrowser(req);
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: 403, headers: NO_STORE });

  const body = (await req.json().catch(() => ({}))) as {
    scope?: unknown;
    name?: unknown;
    value?: unknown;
    secret?: unknown;
    expectedRevision?: unknown;
  };

  if (body.scope !== "app" && body.scope !== "agent")
    return NextResponse.json({ error: "scope must be app or agent." }, { status: 400, headers: NO_STORE });
  if (typeof body.name !== "string")
    return NextResponse.json({ error: "name is required." }, { status: 400, headers: NO_STORE });
  if (typeof body.value !== "string")
    return NextResponse.json({ error: "value must be a string." }, { status: 400, headers: NO_STORE });
  if (!Number.isInteger(body.expectedRevision))
    return NextResponse.json({ error: "expectedRevision is required." }, { status: 400, headers: NO_STORE });

  const result = createVariable({
    scope: body.scope,
    name: body.name,
    value: body.value,
    secret: body.secret === true,
    expectedRevision: body.expectedRevision as number,
  });
  if (!result.ok) return refuse(result);
  return NextResponse.json({ row: result.row, revision: result.revision }, { headers: NO_STORE });
}
