import { NextResponse } from "next/server";
import { z } from "zod";

import { clearProviderSecret, setProviderSecret } from "@/lib/providerSecrets";
import { presentProvider } from "@/lib/providers/present";
import { deleteProvider, getProvider, updateProvider } from "@/lib/providers/store";
import { parseProviderConfig, providerTypeEntry } from "@/lib/providers/types";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    label: z.string().optional(),
    config: z.unknown().optional(),
    model_policy: z.unknown().optional(),
    key: z.string().nullable().optional(),
    admin_key: z.string().nullable().optional(),
  })
  .strict();

type RouteContext = { params: Promise<{ id: string }> };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function GET(_req: Request, { params }: RouteContext) {
  const provider = getProvider((await params).id);
  if (!provider) return NextResponse.json({ error: "no such provider" }, { status: 404 });
  return NextResponse.json({ provider: presentProvider(provider) });
}

export async function PATCH(req: Request, { params }: RouteContext) {
  const id = (await params).id;
  const existing = getProvider(id);
  if (!existing) return NextResponse.json({ error: "no such provider" }, { status: 404 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid provider" }, { status: 400 });
  }
  const body = parsed.data;
  const allowedSecrets = providerTypeEntry(existing.type).secretFields;
  for (const field of ["key", "admin_key"] as const) {
    if (body[field] !== undefined && !allowedSecrets.includes(field)) {
      return NextResponse.json({ error: `${existing.type} providers do not accept ${field}` }, { status: 400 });
    }
  }

  try {
    const config = body.config === undefined ? undefined : parseProviderConfig(existing.type, body.config);
    updateProvider(id, {
      label: body.label,
      config,
      model_policy: body.model_policy,
    });
    for (const field of allowedSecrets) {
      const value = body[field];
      if (value === undefined || value === "") continue;
      if (value === null) clearProviderSecret(id, field);
      else setProviderSecret(id, field, value);
    }
    return NextResponse.json({ provider: presentProvider(getProvider(id)!) });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const id = (await params).id;
  const provider = getProvider(id);
  if (!provider) return NextResponse.json({ error: "no such provider" }, { status: 404 });
  if (provider.bundled) {
    return NextResponse.json(
      { error: "Bundled providers are removed by signing out of their environment." },
      { status: 409 },
    );
  }
  return NextResponse.json({ usage: deleteProvider(id)! });
}
