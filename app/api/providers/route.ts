import { NextResponse } from "next/server";
import { z } from "zod";

import { setProviderSecret } from "@/lib/providerSecrets";
import { presentProvider } from "@/lib/providers/present";
import { createProvider, deleteProvider, getProvider, listProviders } from "@/lib/providers/store";
import {
  isBundledType,
  isProviderType,
  parseProviderConfig,
  providerTypeEntry,
  type SecretField,
} from "@/lib/providers/types";

export const dynamic = "force-dynamic";

const createSchema = z
  .object({
    type: z.string(),
    label: z.string().optional(),
    config: z.unknown().optional(),
    model_policy: z.unknown().optional(),
    key: z.string().nullable().optional(),
    admin_key: z.string().nullable().optional(),
  })
  .strict();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidSecrets(
  type: Parameters<typeof providerTypeEntry>[0],
  body: { key?: string | null; admin_key?: string | null },
): string | null {
  const allowed = providerTypeEntry(type).secretFields;
  for (const field of ["key", "admin_key"] as const) {
    if (body[field] !== undefined && !allowed.includes(field)) return `${type} providers do not accept ${field}`;
  }
  return null;
}

function writeSecrets(
  providerId: string,
  type: Parameters<typeof providerTypeEntry>[0],
  body: { key?: string | null; admin_key?: string | null },
): void {
  for (const field of providerTypeEntry(type).secretFields) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    setProviderSecret(providerId, field as SecretField, value);
  }
}

export async function GET() {
  return NextResponse.json({ providers: listProviders().map(presentProvider) });
}

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid provider" }, { status: 400 });
  }
  const body = parsed.data;
  if (!isProviderType(body.type)) {
    return NextResponse.json({ error: "type is not a recognized provider type" }, { status: 400 });
  }
  if (isBundledType(body.type)) {
    return NextResponse.json(
      { error: "Bundled providers are created by signing in to their environment." },
      { status: 400 },
    );
  }
  const secretError = invalidSecrets(body.type, body);
  if (secretError) return NextResponse.json({ error: secretError }, { status: 400 });

  let created: ReturnType<typeof createProvider> | null = null;
  try {
    const config = parseProviderConfig(body.type, body.config ?? {});
    created = createProvider({
      type: body.type,
      label: body.label,
      config,
      model_policy: body.model_policy,
    });
    writeSecrets(created.id, body.type, body);
    return NextResponse.json({ provider: presentProvider(getProvider(created.id)!) }, { status: 201 });
  } catch (error) {
    // A credential validation failure must not leave a provider row with only
    // half of the submitted configuration.
    if (created) deleteProvider(created.id);
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
