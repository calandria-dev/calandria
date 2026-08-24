// Pins the module-graph layering that keeps sync route entries working in the
// production build.
//
// The agent SDKs (@anthropic-ai/claude-agent-sdk, @openai/codex-sdk) are
// ESM-only serverExternalPackages, which Turbopack emits as ASYNC externals —
// and async-ness propagates to every transitive importer. A module compiled
// async but consumed by a route entry Turbopack happened to compile sync gets a
// pending Promise instead of its namespace: every export reads back undefined
// at runtime. That's exactly how /api/services/grant (public service links) and
// /api/instance/services-restore (boot restore of managed services) 500'd in
// prod: lib/store.ts imported getDriver from the registry for one context-window
// lookup, dragging both SDKs into lib/services.ts's graph.
//
// The fix is lib/agents/capabilities.ts — capability DATA without the SDKs.
// This test walks the static import graph from the low-level modules and fails
// if any path reaches an SDK again.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const FORBIDDEN = ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"];

// Modules that must stay SDK-free, and why:
const PINNED = [
  "lib/store.ts", //     imported by nearly everything; the original poison edge
  "lib/services.ts", //  behind sync-compiled routes (grant, services-restore)
  "lib/db.ts",
  "lib/db-lock.mjs", //          the boot lock; server.js loads it in plain Node, before Next exists
  "lib/agents/capabilities.ts", // the whole point of the module
  "lib/agents/connections.ts", // connection state is ID lookups only — no driving
  "lib/agentTools.ts", //        behind the internal agent-tools routes (stdio bridge)
  "lib/taskMove.ts", //          behind both move routes; store + locks + bus, no driving
  "lib/permissions.ts", //       the tool-permission gate's policy — pure logic, no driving
  "lib/agentCommands.ts", //     which slash commands the menu offers — policy the client imports too
  "lib/agents/claude/planUsage.ts", // plan-usage cache + fetch policy — fs/fetch only, no driving
  "lib/schedule/time.ts", //     pure wall-clock math — no DB, no SDK
  "lib/schedule/store.ts", //    schedules + run ledger; DB only, no driving
  "lib/schedule/due.ts", //      fire/miss/skip adjudication; store + time math only
  "lib/runbooks/store.ts", //    saved task-launch presets; DB only, no driving
  "lib/runbookTools.ts", //      runbook agent-tool policy, behind the internal agent-tools routes
  "lib/runContext.ts", //        why a turn is running; a Map on globalThis, nothing more
  "lib/notifications/notify.ts", //   composes notifications; store + bus only, no driving
  "lib/notifications/dispatcher.ts", // the bus subscriber behind /api/events
  "lib/push/store.ts", //         push subscriptions; DB only
  "lib/push/vapid.ts", //         VAPID keys + JWT; node:crypto + fs only
  "lib/push/encrypt.ts", //       RFC 8291 payload encryption; node:crypto only
  "lib/push/send.ts", //          the push channel notify.ts fans out to; fetch only
  "app/api/notifications/push/route.ts",
  "lib/collab.ts", //             document-collaboration packet; pure (jsdiff only), bundled for the client too
  "lib/worktreeFile.ts", //       the collaboration modal's worktree read guard; fs only
  "app/api/settings/permissions/route.ts",
  "app/api/services/grant/route.ts",
  "app/api/instance/services-restore/route.ts",
];

// Modules that MAY reach an SDK, but only ever through a dynamic `import()`.
//
// Different failure from the one above, same async externals. lib/runner.ts
// statically imports the driver registry, so it IS an async module — and under
// Turbopack an async module's `namespaceObject` is a PROMISE until its factory
// settles, so every static importer of it must be compiled async too. Turbopack
// does that for POST /messages and lib/scheduler.ts but NOT for lib/autoStart.ts,
// because that file closes a cycle back into the async graph:
//
//   autoStart → runner → agents/registry → agents/claude/driver
//             → (call-time import) autoStart
//
// Every emitted copy of autoStart came out a plain sync factory, so `startTurn`
// was read off a pending Promise and EVERY auto-start launch died with
// "(0 , n.startTurn) is not a function" in production while dev worked fine.
// A dynamic import doesn't depend on that propagation — Turbopack's asyncModule
// resolves its promise with the populated namespace — so these entries must not
// grow a STATIC path to an SDK, even though a dynamic one is expected and fine.
const DYNAMIC_ONLY = [
  "lib/autoStart.ts", // in the driver's cycle; must not rely on async propagation
];

// import/export/require specifiers, coarse but sufficient for this repo's
// plain static imports.
const SPECIFIER_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
// The same set minus `import(`: what the module graph links at INIT time, which
// is the only edge async-ness propagates along.
const STATIC_SPECIFIER_RE = /(?:from\s+|require\s*\(\s*)["']([^"']+)["']/g;
const IMPORT_BARE_RE = /^\s*import\s+["']([^"']+)["']/gm;

function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // bare package specifier
  for (const suffix of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`unresolvable import "${spec}" from ${path.relative(ROOT, fromFile)}`);
}

/**
 * All bare-package deps reachable from `entry`, with one witness path each.
 * `staticOnly` drops dynamic `import()` edges, leaving the init-time graph.
 */
function reachablePackages(entry: string, staticOnly = false): Map<string, string[]> {
  const packages = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue: { file: string; trail: string[] }[] = [{ file: path.join(ROOT, entry), trail: [entry] }];
  while (queue.length) {
    const { file, trail } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const re of [staticOnly ? STATIC_SPECIFIER_RE : SPECIFIER_RE, IMPORT_BARE_RE]) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(src)); ) {
        const spec = m[1];
        const local = resolveLocal(file, spec);
        if (local) queue.push({ file: local, trail: [...trail, path.relative(ROOT, local)] });
        else if (!spec.startsWith("node:") && !packages.has(spec)) packages.set(spec, trail);
      }
    }
  }
  return packages;
}

describe("import-graph layering (async-external poisoning)", () => {
  for (const entry of PINNED) {
    it(`${entry} never reaches an agent SDK`, () => {
      const packages = reachablePackages(entry);
      for (const sdk of FORBIDDEN) {
        const trail = packages.get(sdk);
        expect(
          trail,
          trail && `${entry} reaches ${sdk} via:\n  ${trail.join("\n  → ")}\n` +
            `ESM externals compile to async modules under Turbopack and break sync route entries — ` +
            `import capability data from lib/agents/capabilities.ts instead of the driver registry.`
        ).toBeUndefined();
      }
    });
  }

  for (const entry of DYNAMIC_ONLY) {
    it(`${entry} reaches an agent SDK only through a dynamic import()`, () => {
      const staticPackages = reachablePackages(entry, true);
      for (const sdk of FORBIDDEN) {
        const trail = staticPackages.get(sdk);
        expect(
          trail,
          trail && `${entry} STATICALLY reaches ${sdk} via:\n  ${trail.join("\n  → ")}\n` +
            `Turbopack does not propagate async-ness into this module (it closes a cycle back ` +
            `through the driver registry), so a static import of an async module reads every ` +
            `export off a pending Promise. Reach lib/runner.ts with \`await import()\` instead.`
        ).toBeUndefined();
      }
      // …and the pin is not vacuous: it still reaches one dynamically.
      const all = reachablePackages(entry);
      expect(FORBIDDEN.some((sdk) => all.has(sdk))).toBe(true);
    });
  }

  it("the walker itself sees the SDKs where they ARE used (sanity)", () => {
    const packages = reachablePackages("lib/agents/registry.ts");
    for (const sdk of FORBIDDEN) expect(packages.has(sdk)).toBe(true);
  });
});
