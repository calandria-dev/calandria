import { NextResponse } from "next/server";

import { getProvider, providerUsage } from "@/lib/providers/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!getProvider(id)) return NextResponse.json({ error: "no such provider" }, { status: 404 });
  return NextResponse.json({ usage: providerUsage(id) });
}
