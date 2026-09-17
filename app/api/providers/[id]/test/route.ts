import { NextResponse } from "next/server";

import { probeSavedProvider } from "@/lib/providers/probe";
import { getProvider, updateProvider } from "@/lib/providers/store";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const provider = getProvider(id);
  if (!provider) return NextResponse.json({ error: "no such provider" }, { status: 404 });
  const result = await probeSavedProvider(provider);
  updateProvider(id, { last_test: result, last_test_at: Date.now() });
  return NextResponse.json(result);
}
