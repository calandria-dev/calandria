import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Unit coverage for lib/agents/codex/hooks.ts (the pure contract module), plus
// end-to-end coverage of lib/agents/codex/driver.ts's listHooks/reviewHooks
// against a FAKE `codex` binary (tests/fixtures/codex/fake-app-server.mjs),
// the same harness tests/codexAppServer.test.ts drives. Wire shapes below are
// the real payloads captured live from codex-cli 0.153.0.

vi.hoisted(() => {
  process.env.CODEX_TRANSPORT = "app-server";
  const sep = process.platform === "win32" ? "\\" : "/";
  process.env.CODEX_CLI_PATH = [__dirname, "fixtures", "codex", process.platform === "win32" ? "fake-app-server.cmd" : "fake-app-server.mjs"].join(sep);
});

import {
  parseHooksList,
  allHooks,
  hookSkipReason,
  skippedHooks,
  describeHook,
  hookTrustKeyPath,
  hookEnabledKeyPath,
  hookTrustEdit,
  hookUntrustEdit,
  hookEnabledEdit,
  isProjectUntrustedWarning,
  parseHookRun,
  isCleanHookRun,
  hookRunDenied,
  hookRunNotice,
  type CodexHook,
} from "@/lib/agents/codex/hooks";
import { codexDriver } from "@/lib/agents/codex/driver";

// The real `hooks/list` payload for a trusted project with two project hooks,
// captured live (see lib/agents/codex/hooks.ts's docblock for the same data).
const REAL_HOOKS_PAYLOAD = {
  data: [
    {
      cwd: "/tmp/p/proj",
      hooks: [
        {
          key: "/tmp/p/proj/.codex/hooks.json:pre_tool_use:0:0",
          eventName: "preToolUse",
          handlerType: "command",
          command: "/bin/true",
          async: false,
          matcher: "shell",
          timeoutSec: 600,
          statusMessage: "probe gate",
          additionalContextLimit: null,
          sourcePath: "/tmp/p/proj/.codex/hooks.json",
          source: "project",
          pluginId: null,
          displayOrder: 0,
          enabled: true,
          isManaged: false,
          currentHash: "sha256:2d3134577587d6581d783676bfa60eae2e9e1a89e2dec95f9220754fee9fd105",
          trustStatus: "untrusted",
        },
        {
          key: "/tmp/p/proj/.codex/hooks.json:post_tool_use:0:0",
          eventName: "postToolUse",
          handlerType: "command",
          command: "/bin/true",
          async: false,
          matcher: null,
          timeoutSec: 600,
          statusMessage: null,
          additionalContextLimit: null,
          sourcePath: "/tmp/p/proj/.codex/hooks.json",
          source: "project",
          pluginId: null,
          displayOrder: 1,
          enabled: true,
          isManaged: false,
          currentHash: "sha256:ef95ed3c5f028e7e94f5c20a828cc12509a81f1efceaf9a2ccd44aca3225309d",
          trustStatus: "untrusted",
        },
      ],
      warnings: [],
      errors: [],
    },
  ],
};

const UNTRUSTED_PROJECT_SUMMARY =
  "Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load.\n" +
  "    1. /tmp/p/proj/.codex\n" +
  "       /tmp/p/proj is marked as untrusted in the effective configuration. ...\n";

function hook(overrides: Partial<CodexHook> = {}): CodexHook {
  return {
    key: "/proj/.codex/hooks.json:preToolUse:0:0",
    eventName: "preToolUse",
    matcher: null,
    handlerType: "command",
    command: "/bin/true",
    sourcePath: "/proj/.codex/hooks.json",
    source: "project",
    pluginId: null,
    timeoutSec: 600,
    statusMessage: null,
    displayOrder: 0,
    enabled: true,
    isManaged: false,
    currentHash: "sha256:deadbeef",
    trustStatus: "trusted",
    ...overrides,
  };
}

describe("parseHooksList", () => {
  it("parses the real two-hook payload exactly, sorted by displayOrder", () => {
    const inv = parseHooksList(REAL_HOOKS_PAYLOAD);
    expect(inv.scopes).toHaveLength(1);
    expect(inv.suppressedReason).toBeUndefined();
    const hooks = allHooks(inv);
    expect(hooks).toHaveLength(2);
    expect(hooks.map((h) => h.key)).toEqual([
      "/tmp/p/proj/.codex/hooks.json:pre_tool_use:0:0",
      "/tmp/p/proj/.codex/hooks.json:post_tool_use:0:0",
    ]);
    expect(hooks[0]).toEqual({
      key: "/tmp/p/proj/.codex/hooks.json:pre_tool_use:0:0",
      eventName: "preToolUse",
      matcher: "shell",
      handlerType: "command",
      command: "/bin/true",
      async: false,
      sourcePath: "/tmp/p/proj/.codex/hooks.json",
      source: "project",
      pluginId: null,
      timeoutSec: 600,
      statusMessage: "probe gate",
      displayOrder: 0,
      enabled: true,
      isManaged: false,
      currentHash: "sha256:2d3134577587d6581d783676bfa60eae2e9e1a89e2dec95f9220754fee9fd105",
      trustStatus: "untrusted",
    });
    expect(hooks[1].key).toBe("/tmp/p/proj/.codex/hooks.json:post_tool_use:0:0");
    expect(hooks[1].matcher).toBeNull();
  });

  it("skips a malformed hook (no key) while its siblings survive, and degrades unknown fields to the safe reading", () => {
    const payload = {
      data: [
        {
          cwd: "/proj",
          hooks: [
            { eventName: "preToolUse", handlerType: "command", currentHash: "sha256:x" }, // no key: dropped
            hook({ key: "ok-1", trustStatus: "somethingNew" as unknown as CodexHook["trustStatus"] }),
          ],
          warnings: [],
          errors: [],
        },
      ],
    };
    const inv = parseHooksList(payload);
    const hooks = allHooks(inv);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].key).toBe("ok-1");
    // An unrecognized trust status degrades to "untrusted", the safe reading:
    // it never claims a definition was reviewed when this build can't tell.
    expect(hooks[0].trustStatus).toBe("untrusted");
  });

  it("degrades an unrecognized hook-run status to failed and a non-array data to an empty scope list", () => {
    expect(parseHooksList({ data: "not an array" }).scopes).toEqual([]);
    expect(parseHooksList(null).scopes).toEqual([]);
    expect(parseHooksList(undefined).scopes).toEqual([]);

    const run = parseHookRun({ id: "r1", status: "somethingNew" });
    expect(run?.status).toBe("failed");
  });

  it("carries suppressedReason only when given one, distinguishing absent hooks from a suppressed project", () => {
    const bare = parseHooksList({ data: [] });
    expect(bare.suppressedReason).toBeUndefined();
    expect(allHooks(bare)).toEqual([]);

    const suppressed = parseHooksList({ data: [] }, UNTRUSTED_PROJECT_SUMMARY);
    expect(suppressed.suppressedReason).toBe(UNTRUSTED_PROJECT_SUMMARY);
    expect(allHooks(suppressed)).toEqual([]);
    // Both inventories have zero hooks; only suppressedReason tells them apart.
    expect(bare.scopes).toEqual(suppressed.scopes);
  });
});

describe("isProjectUntrustedWarning", () => {
  it("matches the real untrusted-project configWarning summary", () => {
    expect(isProjectUntrustedWarning(UNTRUSTED_PROJECT_SUMMARY)).toBe(true);
  });

  it("does not match an unrelated configWarning", () => {
    expect(isProjectUntrustedWarning("fake warning: nothing is wrong")).toBe(false);
    expect(isProjectUntrustedWarning("the sandbox could not be created")).toBe(false);
  });
});

describe("hookTrustKeyPath / hookEnabledKeyPath: the TOML quoting invariant", () => {
  it("quotes the hook key as one TOML segment, for the real key", () => {
    const key = "/tmp/p/proj/.codex/hooks.json:pre_tool_use:0:0";
    expect(hookTrustKeyPath(key)).toBe(
      'hooks.state."/tmp/p/proj/.codex/hooks.json:pre_tool_use:0:0".trusted_hash',
    );
    expect(hookEnabledKeyPath(key)).toBe(
      'hooks.state."/tmp/p/proj/.codex/hooks.json:pre_tool_use:0:0".enabled',
    );
  });

  it("is not three bare dotted segments: the key segment is quoted, not split on its own dots", () => {
    const path = hookTrustKeyPath("/tmp/p/proj/.codex/hooks.json:pre_tool_use:0:0");
    // hooks . state . "<quoted key>" . trusted_hash: exactly 4 top-level dotted
    // segments once the quoted one is accounted for, never one per embedded dot.
    expect(path.startsWith('hooks.state."')).toBe(true);
    expect(path.endsWith('".trusted_hash')).toBe(true);
    const middle = path.slice('hooks.state."'.length, path.length - '".trusted_hash'.length);
    expect(middle).toBe("/tmp/p/proj/.codex/hooks.json:pre_tool_use:0:0");
  });

  it("escapes a double quote and a backslash inside the key", () => {
    const key = 'C:\\weird\\path\\hooks.json:"quoted":0:0';
    const p = hookTrustKeyPath(key);
    // Every backslash and quote inside the segment is escaped, and the whole
    // segment is still wrapped in exactly one pair of unescaped quotes.
    expect(p).toBe('hooks.state."C:\\\\weird\\\\path\\\\hooks.json:\\"quoted\\":0:0".trusted_hash');
  });
});

describe("hookTrustEdit / hookUntrustEdit / hookEnabledEdit", () => {
  it("stores currentHash verbatim, sha256 prefix included, with an upsert merge strategy", () => {
    const h = hook({ currentHash: "sha256:2d3134577587d6581d783676bfa60eae2e9e1a89e2dec95f9220754fee9fd105" });
    const edit = hookTrustEdit(h);
    expect(edit).toEqual({
      keyPath: hookTrustKeyPath(h.key),
      value: "sha256:2d3134577587d6581d783676bfa60eae2e9e1a89e2dec95f9220754fee9fd105",
      mergeStrategy: "upsert",
    });
    // Not a bare hex digest: that would leave the hook reading "modified".
    expect(String(edit.value)).toMatch(/^sha256:/);
  });

  it("hookUntrustEdit writes the trust key path but not a hash", () => {
    const h = hook();
    const edit = hookUntrustEdit(h);
    expect(edit.keyPath).toBe(hookTrustKeyPath(h.key));
    expect(edit.mergeStrategy).toBe("upsert");
    expect(edit.value).not.toMatch(/^sha256:/);
  });

  it("hookEnabledEdit writes the enabled key path with the requested boolean", () => {
    const h = hook();
    expect(hookEnabledEdit(h, false)).toEqual({ keyPath: hookEnabledKeyPath(h.key), value: false, mergeStrategy: "upsert" });
    expect(hookEnabledEdit(h, true)).toEqual({ keyPath: hookEnabledKeyPath(h.key), value: true, mergeStrategy: "upsert" });
  });
});

describe("hookSkipReason / skippedHooks", () => {
  it("disabled outranks trust", () => {
    expect(hookSkipReason(hook({ enabled: false, trustStatus: "trusted" }))).toBe("disabled");
    expect(hookSkipReason(hook({ enabled: false, trustStatus: "untrusted" }))).toBe("disabled");
  });

  it("untrusted and modified each give their own reason", () => {
    expect(hookSkipReason(hook({ enabled: true, trustStatus: "untrusted" }))).toBe("never reviewed");
    expect(hookSkipReason(hook({ enabled: true, trustStatus: "modified" }))).toBe("edited since it was reviewed");
  });

  it("trusted-and-enabled and managed-and-enabled both run, no skip reason", () => {
    expect(hookSkipReason(hook({ enabled: true, trustStatus: "trusted" }))).toBeNull();
    expect(hookSkipReason(hook({ enabled: true, trustStatus: "managed", isManaged: true }))).toBeNull();
  });

  it("skippedHooks reports every skip with its hook and reason", () => {
    const inv = parseHooksList({
      data: [
        {
          cwd: "/proj",
          hooks: [hook({ key: "a", enabled: false }), hook({ key: "b", trustStatus: "trusted" }), hook({ key: "c", trustStatus: "modified" })],
          warnings: [],
          errors: [],
        },
      ],
    });
    const skips = skippedHooks(inv);
    expect(skips.map((s) => [s.hook.key, s.reason])).toEqual([
      ["a", "disabled"],
      ["c", "edited since it was reviewed"],
    ]);
  });
});

describe("describeHook", () => {
  it("names a command hook, with and without a matcher", () => {
    expect(describeHook(hook({ eventName: "preToolUse", matcher: "shell", command: "/bin/true" }))).toBe("preToolUse(shell): /bin/true");
    expect(describeHook(hook({ eventName: "postToolUse", matcher: null, command: "/bin/true" }))).toBe("postToolUse: /bin/true");
  });

  it("names an mcpTool hook by server/tool", () => {
    expect(
      describeHook(
        hook({ handlerType: "mcpTool", command: undefined, server: "calandria", tool: "list_tasks", eventName: "preToolUse", matcher: null }),
      ),
    ).toBe("preToolUse: calandria/list_tasks");
  });
});

describe("hook-run helpers", () => {
  function run(overrides: Record<string, unknown> = {}) {
    return {
      id: "run-1",
      eventName: "preToolUse",
      handlerType: "command",
      executionMode: "sync",
      scope: "turn",
      sourcePath: "/proj/.codex/hooks.json",
      source: "project",
      status: "completed",
      statusMessage: null,
      durationMs: 12,
      entries: [],
      ...overrides,
    };
  }

  it("parseHookRun normalizes a realistic HookRunSummary", () => {
    const parsed = parseHookRun(
      run({
        entries: [
          { kind: "stop", text: "blocked: dangerous command" },
          { kind: "context", text: "" }, // dropped: no text
        ],
      }),
    );
    expect(parsed).toMatchObject({
      id: "run-1",
      eventName: "preToolUse",
      handlerType: "command",
      executionMode: "sync",
      scope: "turn",
      sourcePath: "/proj/.codex/hooks.json",
      source: "project",
      status: "completed",
      durationMs: 12,
    });
    expect(parsed?.entries).toEqual([{ kind: "stop", text: "blocked: dangerous command" }]);
  });

  it("isCleanHookRun is true only for completed with no stop/error/warning entries", () => {
    expect(isCleanHookRun(parseHookRun(run())!)).toBe(true);
    expect(isCleanHookRun(parseHookRun(run({ status: "failed" }))!)).toBe(false);
    expect(isCleanHookRun(parseHookRun(run({ entries: [{ kind: "stop", text: "no" }] }))!)).toBe(false);
    expect(isCleanHookRun(parseHookRun(run({ entries: [{ kind: "error", text: "boom" }] }))!)).toBe(false);
    expect(isCleanHookRun(parseHookRun(run({ entries: [{ kind: "warning", text: "hmm" }] }))!)).toBe(false);
    // A feedback-only entry is not a denial, so a clean run may still carry one.
    expect(isCleanHookRun(parseHookRun(run({ entries: [{ kind: "feedback", text: "fyi" }] }))!)).toBe(true);
  });

  it("hookRunDenied is true for blocked, for stopped, and for completed with a stop entry", () => {
    expect(hookRunDenied(parseHookRun(run({ status: "blocked" }))!)).toBe(true);
    expect(hookRunDenied(parseHookRun(run({ status: "stopped" }))!)).toBe(true);
    expect(hookRunDenied(parseHookRun(run({ status: "completed", entries: [{ kind: "stop", text: "no" }] }))!)).toBe(true);
    expect(hookRunDenied(parseHookRun(run({ status: "completed" }))!)).toBe(false);
    expect(hookRunDenied(parseHookRun(run({ status: "failed" }))!)).toBe(false);
  });

  it("hookRunNotice names the event, the denial wording, and the sourcePath", () => {
    const notice = hookRunNotice(
      parseHookRun(
        run({ status: "blocked", source: "project", sourcePath: "/proj/.codex/hooks.json", entries: [{ kind: "stop", text: "dangerous" }] }),
      )!,
    );
    expect(notice).toContain("preToolUse");
    expect(notice).toContain("blocked the call");
    expect(notice).toContain("/proj/.codex/hooks.json");
    expect(notice).toContain("stop: dangerous");
  });
});

// ---------------------------------------------------------------------------
// End to end: the real driver against a fake `codex app-server`.
// ---------------------------------------------------------------------------

const tmp: string[] = [];
let logFile = "";

beforeEach(() => {
  logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-hooks-log-")), "log.jsonl");
  tmp.push(path.dirname(logFile));
  process.env.FAKE_CODEX_LOG = logFile;
});

afterEach(() => {
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_SCENARIO;
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});

function scratchCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hooks-cwd-"));
  tmp.push(dir);
  return dir;
}

type Log = { argv?: string[]; method?: string; params?: Record<string, unknown> };
const readLog = (): Log[] =>
  fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Log) : [];
const logged = (method: string) => readLog().filter((l) => l.method === method).map((l) => l.params);

describe("codexDriver.listHooks / reviewHooks against the fake app-server", () => {
  it("listHooks returns the parsed inventory the fixture answers with", async () => {
    process.env.FAKE_CODEX_SCENARIO = "hooks";
    const cwd = scratchCwd();
    const result = await codexDriver.listHooks!(cwd);
    expect(result.error).toBeUndefined();
    const hooks = allHooks(result.inventory!);
    expect(hooks.map((h) => h.key)).toEqual([
      "/tmp/p/proj/.codex/hooks.json:pre_tool_use:0:0",
      "/tmp/p/proj/.codex/hooks.json:post_tool_use:0:0",
    ]);
    expect(result.inventory!.suppressedReason).toBeUndefined();
    // The call is cwd-scoped: hooks/list carries the caller's cwd, not the
    // account-scoped default (lib/agents/codex/appServer.ts's opts.cwd).
    expect(logged("hooks/list")[0]).toMatchObject({ cwds: [cwd] });
  });

  it("the untrusted-project scenario produces an inventory with suppressedReason set from the configWarning", async () => {
    process.env.FAKE_CODEX_SCENARIO = "hooksUntrustedProject";
    const cwd = scratchCwd();
    const result = await codexDriver.listHooks!(cwd);
    expect(result.error).toBeUndefined();
    expect(allHooks(result.inventory!)).toEqual([]);
    // If this proves flaky (the settle window racing the notification), that
    // is a real timing hazard in lib/agents/codex/appServer.ts's SETTLE_MS and
    // must be reported, not retried away.
    expect(result.inventory!.suppressedReason).toContain("until the project is trusted");
  });

  it("reviewHooks(trust) writes a config/batchWrite with the correctly quoted keyPath and the hook's live currentHash", async () => {
    process.env.FAKE_CODEX_SCENARIO = "hooks";
    const cwd = scratchCwd();
    const key = "/tmp/p/proj/.codex/hooks.json:pre_tool_use:0:0";
    const result = await codexDriver.reviewHooks!(cwd, [{ key, action: "trust" }]);
    expect(result.ok).toBe(true);
    const writes = logged("config/batchWrite");
    expect(writes).toHaveLength(1);
    const edits = (writes[0] as { edits: { keyPath: string; value: unknown; mergeStrategy: string }[] }).edits;
    expect(edits).toEqual([
      {
        keyPath: 'hooks.state."/tmp/p/proj/.codex/hooks.json:pre_tool_use:0:0".trusted_hash',
        // The hash written is the one the fixture's OWN inventory reports for
        // this key, never a value the caller could have supplied: reviewHooks
        // re-reads the inventory before writing.
        value: "sha256:2d3134577587d6581d783676bfa60eae2e9e1a89e2dec95f9220754fee9fd105",
        mergeStrategy: "upsert",
      },
    ]);
  });

  it("reviewHooks refuses an unknown key, naming it, and writes nothing", async () => {
    process.env.FAKE_CODEX_SCENARIO = "hooks";
    const cwd = scratchCwd();
    const result = await codexDriver.reviewHooks!(cwd, [{ key: "no-such-hook", action: "trust" }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no-such-hook");
    expect(logged("config/batchWrite")).toEqual([]);
  });

  it("reviewHooks refuses trust on a hook an administrator has pinned (isManaged)", async () => {
    process.env.FAKE_CODEX_SCENARIO = "hooksManaged";
    const cwd = scratchCwd();
    const key = "/tmp/p/proj/.codex/hooks.json:stop:0:0";
    const result = await codexDriver.reviewHooks!(cwd, [{ key, action: "trust" }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(key);
    expect(logged("config/batchWrite")).toEqual([]);
  });
});
