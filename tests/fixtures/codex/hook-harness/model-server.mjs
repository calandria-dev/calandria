#!/usr/bin/env node
// Loopback model fixture for the Codex hook harness (docs/CODEX_HOOK_HARNESS.md).
//
// Serves the one endpoint the Codex CLI calls under `wire_api = "responses"`:
// POST /v1/responses, answered as a Server-Sent Events stream. It stands in for
// a model so the harness spends no account and reaches no live service. It is
// reached through Calandria's ordinary provider override
// (lib/agents/codex/provider.ts), so the harness exercises the same path a user
// pointing Codex at Ollama or LM Studio takes.
//
// Behaviour is scripted. CALANDRIA_HARNESS_PLAN names a JSON file holding
// `{ "steps": [...] }`, one step per request the CLI makes, in order:
//
//   { "kind": "tool", "match": "ledger_note", "arguments": { ... } }
//     Answer with a function_call. `match` is a substring; the fixture resolves
//     it against the tool names the CLI actually advertised in the request, so
//     the plan does not have to hard-code how Codex namespaces an MCP tool.
//   { "kind": "text", "text": "..." }
//     Answer with an assistant message and end the turn.
//
// Requests past the end of the plan get a plain text answer, so an unexpected
// extra round trip ends the turn instead of hanging it.
//
// Every request is appended to CALANDRIA_HARNESS_REQUESTS as one JSON line
// (model, advertised tool names, the input items), which is what tells you
// whether an MCP tool reached the model as a top-level function at all.

import fs from "node:fs";
import http from "node:http";

const PLAN_PATH = process.env.CALANDRIA_HARNESS_PLAN || "";
const REQUESTS = process.env.CALANDRIA_HARNESS_REQUESTS || "";
const TOOL_SCHEMAS = process.env.CALANDRIA_HARNESS_TOOL_SCHEMAS || "";
const plan = PLAN_PATH ? JSON.parse(fs.readFileSync(PLAN_PATH, "utf8")) : { steps: [] };
const steps = Array.isArray(plan.steps) ? plan.steps : [];

let requestCount = 0;

function log(entry) {
  if (!REQUESTS) return;
  fs.appendFileSync(REQUESTS, `${JSON.stringify(entry)}\n`);
}

/**
 * Every tool name the CLI advertised, flattened. An MCP server does not reach
 * the model as top-level functions: it arrives as one `{ type: "namespace",
 * name: "mcp__<server>", tools: [...] }` entry holding the server's own tools,
 * and the model calls those by their own name. Both levels are returned so a
 * plan can name either.
 */
function advertised(tools) {
  const out = [];
  for (const t of tools || []) {
    if (typeof t?.name === "string" && t.type !== "namespace") out.push({ name: t.name, namespace: null });
    for (const nested of t?.tools || []) {
      if (typeof nested?.name === "string") out.push({ name: nested.name, namespace: t.name });
    }
  }
  return out;
}

/** Just the names, for logging and for the "no match" message. */
function advertisedNames(tools) {
  return advertised(tools).map((t) => (t.namespace ? `${t.namespace}/${t.name}` : t.name));
}

/**
 * The advertised tool matching `match` exactly, else containing it, else null.
 * A tool inside a namespace is called by its own `name` with the namespace
 * carried on the call item's `namespace` field. Verified against codex-cli
 * 0.153.0: a dotted, double-underscored or bare name is answered
 * "unsupported call".
 */
function resolveTool(tools, match) {
  const all = advertised(tools);
  return all.find((t) => t.name === match) || all.find((t) => t.name.includes(match)) || null;
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** One complete Responses stream carrying `items` as the model's output. */
function streamResponse(res, items) {
  const response = { id: `resp_${requestCount}`, object: "response", status: "in_progress", output: [] };
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  sse(res, "response.created", { type: "response.created", response });
  sse(res, "response.in_progress", { type: "response.in_progress", response });
  items.forEach((item, index) => {
    sse(res, "response.output_item.added", { type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress" } });
    if (item.type === "message") {
      const text = item.content?.[0]?.text ?? "";
      sse(res, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: text,
      });
      sse(res, "response.output_text.done", {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: index,
        content_index: 0,
        text,
      });
    } else if (item.type === "function_call") {
      sse(res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: index,
        arguments: item.arguments,
      });
    }
    sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: index, item });
  });
  const completed = {
    ...response,
    status: "completed",
    output: items,
    usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
  };
  sse(res, "response.completed", { type: "response.completed", response: completed });
  res.end();
}

function message(text) {
  return { type: "message", id: `msg_${requestCount}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}

function handle(res, body) {
  const step = steps[requestCount];
  requestCount += 1;
  const tools = body.tools || [];
  log({ n: requestCount, model: body.model, tools: advertisedNames(tools), input: body.input });
  // The full tool definitions, once: this is how you find out whether an MCP
  // server reached the model as top-level functions or behind one nested tool,
  // and what argument shape that nested tool takes.
  if (requestCount === 1 && TOOL_SCHEMAS) fs.writeFileSync(TOOL_SCHEMAS, `${JSON.stringify(tools, null, 2)}\n`);

  if (!step || step.kind === "text") {
    streamResponse(res, [message(step?.text ?? "harness plan exhausted; ending the turn.")]);
    return;
  }
  if (step.kind === "raw") {
    // Emit a literal output item. For probing call conventions the fixture
    // does not otherwise model.
    streamResponse(res, [step.item]);
    return;
  }
  if (step.kind === "tool") {
    // `name` calls a literal name without resolving it; `match` resolves
    // against what the CLI advertised.
    const found = step.name ? { name: step.name, namespace: step.namespace ?? null } : resolveTool(tools, step.match);
    if (!found) {
      // Loud on purpose: the plan asked for a tool the CLI never advertised,
      // which is the finding, not a harness crash. It lands in the transcript
      // and in the request log beside the names that WERE advertised.
      streamResponse(res, [message(`harness: no advertised tool matches ${JSON.stringify(step.match)}; advertised: ${JSON.stringify(advertisedNames(tools))}`)]);
      return;
    }
    streamResponse(res, [
      {
        type: "function_call",
        id: `fc_${requestCount}`,
        call_id: step.call_id || `call_${requestCount}`,
        name: found.name,
        ...(found.namespace ? { namespace: found.namespace } : {}),
        arguments: JSON.stringify(step.arguments ?? {}),
        status: "completed",
      },
    ]);
    return;
  }
  streamResponse(res, [message(`harness: unknown step kind ${JSON.stringify(step.kind)}`)]);
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/responses")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `harness fixture serves POST /v1/responses only, got ${req.method} ${req.url}` } }));
      return;
    }
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "harness fixture could not parse the request body" } }));
      return;
    }
    handle(res, body);
  });
});

const port = Number(process.env.CALANDRIA_HARNESS_MODEL_PORT || 0);
server.listen(port, "127.0.0.1", () => {
  // The port goes to stdout so a caller that asked for an ephemeral one can
  // read it back.
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
