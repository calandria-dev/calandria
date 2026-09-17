import { NextResponse } from "next/server";
import { z } from "zod";

import { probeProvider } from "@/lib/providers/probe";
import {
  isProviderType,
  parseProviderConfig,
  providerTypeEntry,
  type SecretField,
} from "@/lib/providers/types";

export const dynamic = "force-dynamic";

const testSchema = z
  .object({
    type: z.string(),
    config: z.unknown().optional(),
    key: z.string().nullable().optional(),
    admin_key: z.string().nullable().optional(),
  })
  .passthrough();

export async function POST(req: Request) {
  const parsed = testSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "type is not a recognized provider type" }, { status: 400 });
  }
  const body = parsed.data;
  const type = body.type;
  if (!isProviderType(type)) {
    return NextResponse.json({ error: "type is not a recognized provider type" }, { status: 400 });
  }
  try {
    const config = parseProviderConfig(type, body.config ?? {});
    const secrets: Partial<Record<SecretField, string>> = {};
    for (const field of providerTypeEntry(type).secretFields) {
      const value = body[field];
      if (typeof value === "string") secrets[field] = value;
    }
    return NextResponse.json(await probeProvider({ type, config, secrets }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
