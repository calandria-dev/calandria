#!/usr/bin/env node
// Inert stdio MCP server for the Codex hook harness (docs/CODEX_HOOK_HARNESS.md).
//
// It exposes two tools that do nothing but record. Every call appends one JSON
// line to CALANDRIA_HARNESS_LEDGER holding the tool name and the arguments
// exactly as they arrived. The ledger is the harness's evidence: an allowed
// call must appear with its arguments unchanged, and a call a hook denied must
// leave no line. Nothing here touches the network or the filesystem
// outside that one append-only file.

import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LEDGER = process.env.CALANDRIA_HARNESS_LEDGER || "";

/** Append one call to the ledger. Sync, so a killed process still leaves it. */
function record(tool, args) {
  if (!LEDGER) return;
  fs.appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), tool, args })}\n`);
}

const server = new McpServer({ name: "ledger", version: "1.0.0" });

server.registerTool(
  "ledger_note",
  {
    title: "Record a note",
    description:
      "Records a note in the harness ledger and returns it. Does nothing else: no network, no files, no side effects.",
    inputSchema: { note: z.string().describe("Text to record verbatim.") },
  },
  async (args) => {
    record("ledger_note", args);
    return { content: [{ type: "text", text: `recorded: ${args.note}` }] };
  },
);

server.registerTool(
  "ledger_probe",
  {
    title: "Record a probe",
    description:
      "Records a probe in the harness ledger and returns it. Does nothing else: no network, no files, no side effects.",
    inputSchema: {
      label: z.string().describe("Label to record verbatim."),
      payload: z.string().optional().describe("Optional extra text to record verbatim."),
    },
  },
  async (args) => {
    record("ledger_probe", args);
    return { content: [{ type: "text", text: `probed: ${args.label}` }] };
  },
);

await server.connect(new StdioServerTransport());
