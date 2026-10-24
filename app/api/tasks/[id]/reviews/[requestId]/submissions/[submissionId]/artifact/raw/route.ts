import { reviewErrorResponse } from "@/lib/reviews/http";
import { readRawDocument } from "@/lib/reviews/read";

export const dynamic = "force-dynamic";

/**
 * The exact stored bytes of a document artifact, BOM and line endings intact.
 * The ETag is the SHA-256 of those bytes. Never the editor's draft. Auth: middleware.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; requestId: string; submissionId: string }> }) {
  const { id, requestId, submissionId } = await params;
  try {
    const { bytes, sha256 } = readRawDocument(id, requestId, submissionId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "text/markdown;charset=utf-8",
        "Content-Length": String(bytes.length),
        ETag: `"${sha256}"`,
        "Cache-Control": "private, no-store",
        "Content-Disposition": 'attachment; filename="document.md"',
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return reviewErrorResponse(e);
  }
}
