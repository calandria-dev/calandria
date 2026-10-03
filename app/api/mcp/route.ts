import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { externalMcpEnabled, externalMcpTokenOk } from "@/lib/auth/origin.mjs";
import { buildExternalMcpServer } from "@/lib/externalMcp";
import { maybeAutoStartDependents } from "@/lib/autoStart";

export const dynamic = "force-dynamic";

// The external MCP endpoint: Calandria's task tools for agents running outside
// it (lib/externalMcp.ts), over MCP Streamable HTTP. Off unless
// CALANDRIA_MCP_TOKEN is set; every request presents it as
// `Authorization: Bearer <token>`. middleware.ts enforces the same check before
// any browser-origin rule, and it is repeated here so the route never serves a
// request that reached it some other way.
//
// Stateless: each request gets a fresh server and transport, with no session
// id, so nothing is held across requests, reloads or HMR. JSON responses
// instead of an SSE stream, since every tool answers in one reply.
async function handle(req: Request): Promise<Response> {
  if (!externalMcpEnabled()) return new Response("Not found.\n", { status: 404 });
  if (!externalMcpTokenOk(req.headers.get("authorization"))) {
    return new Response("Unauthorized.\n", { status: 401, headers: { "www-authenticate": 'Bearer realm="calandria-mcp"' } });
  }
  const server = buildExternalMcpServer({ onBlockerCleared: maybeAutoStartDependents });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
