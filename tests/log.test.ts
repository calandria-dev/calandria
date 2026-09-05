// The shared line emitter (lib/log.mjs). Pins two invariants: the default
// output is byte-for-byte the bracket form this app prints, so an existing
// grep does not break on upgrade, and the json form is parseable, including
// for the values an error path hands a logger, where a naive
// JSON.stringify can turn a failure report into a second, uncaught one.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger, formatLogLine, resolveLogFormat } from "@/lib/log.mjs";

const TS = Date.UTC(2026, 7, 27, 12, 0, 0);

afterEach(() => {
  delete process.env.CALANDRIA_LOG_FORMAT;
  vi.restoreAllMocks();
});

describe("resolveLogFormat", () => {
  it("defaults to text and only json opts in", () => {
    expect(resolveLogFormat({})).toBe("text");
    expect(resolveLogFormat({ CALANDRIA_LOG_FORMAT: "" })).toBe("text");
    expect(resolveLogFormat({ CALANDRIA_LOG_FORMAT: "text" })).toBe("text");
    expect(resolveLogFormat({ CALANDRIA_LOG_FORMAT: "json" })).toBe("json");
    // Tolerant about shape, not about meaning: a value from a .env file arrives
    // with whatever spacing and case the operator typed.
    expect(resolveLogFormat({ CALANDRIA_LOG_FORMAT: "  JSON " })).toBe("json");
    // A typo is NOT json, and must not be: half-JSON output is worse than none.
    expect(resolveLogFormat({ CALANDRIA_LOG_FORMAT: "jsonl" })).toBe("text");
  });

  it("never reads the deprecated ORCH_ spelling — this knob is new", () => {
    // lib/env.mjs's alias table exists to keep PRE-RENAME names resolving. A
    // knob born after the rename that answered to ORCH_* would be born
    // deprecated, so this one is read straight off the environment.
    expect(resolveLogFormat({ ORCH_LOG_FORMAT: "json" })).toBe("text");
  });
});

describe("text format (the default)", () => {
  it("is the bracket line the call sites used to print", () => {
    expect(formatLogLine({ level: "info", component: "runner", msg: "turn ok", ts: TS }, "text")).toBe(
      "[runner] turn ok",
    );
  });

  it("appends fields as key=value, quoting only what would break the pairing", () => {
    const line = formatLogLine(
      {
        level: "info",
        component: "runner",
        msg: "turn ok",
        ts: TS,
        fields: { task: "abc", ms: 8412, cost_usd: 0.4113, superseded: false, note: "two words" },
      },
      "text",
    );
    expect(line).toBe('[runner] turn ok task=abc ms=8412 cost_usd=0.4113 superseded=false note="two words"');
  });

  it("drops undefined fields, so a call site can pass optional ones unconditionally", () => {
    const line = formatLogLine(
      { level: "error", component: "runner", msg: "turn failed", ts: TS, fields: { task: "abc", error: undefined } },
      "text",
    );
    expect(line).toBe("[runner] turn failed task=abc");
  });

  it("renders an Error as its stack — what console.error(msg, err) already printed", () => {
    const err = new Error("boom");
    const line = formatLogLine({ level: "error", component: "runner", msg: "crashed", ts: TS, fields: { err } }, "text");
    expect(line).toContain("[runner] crashed err=");
    expect(line).toContain("Error: boom");
    expect(line).toContain("log.test.ts");
  });
});

describe("json format", () => {
  it("carries timestamp, level, component and the line's own fields", () => {
    const line = formatLogLine(
      { level: "info", component: "runner", msg: "turn ok", ts: TS, fields: { task: "abc", ms: 8412 } },
      "json",
    );
    expect(JSON.parse(line)).toEqual({
      ts: "2026-08-27T12:00:00.000Z",
      level: "info",
      component: "runner",
      msg: "turn ok",
      task: "abc",
      ms: 8412,
    });
  });

  it("keeps the envelope keys for itself", () => {
    // A field named `level` would otherwise rewrite the severity a collector
    // routes on, which a call site must not be able to do by accident.
    const line = formatLogLine(
      { level: "warn", component: "server", msg: "hi", ts: TS, fields: { level: "info", component: "nope", msg: "x" } },
      "json",
    );
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("warn");
    expect(parsed.component).toBe("server");
    expect(parsed.msg).toBe("hi");
  });

  it("serializes an Error so both message and stack are indexable", () => {
    const parsed = JSON.parse(
      formatLogLine({ level: "error", component: "runner", msg: "crashed", ts: TS, fields: { err: new Error("boom") } }, "json"),
    );
    expect(parsed.err.name).toBe("Error");
    expect(parsed.err.message).toBe("boom");
    expect(parsed.err.stack).toContain("Error: boom");
  });

  it("survives a circular value instead of throwing inside the failure handler", () => {
    // server.js hands process.on("unhandledRejection") its raw reason, which
    // is whatever the rejected promise was holding. A throw here would take
    // out the handler that exists to keep the process alive.
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const line = formatLogLine(
      { level: "error", component: "server", msg: "UNHANDLED REJECTION", ts: TS, fields: { err: circular } },
      "json",
    );
    expect(JSON.parse(line).err).toEqual({ a: 1, self: "[circular]" });
  });
});

describe("createLogger", () => {
  it("routes by level and reads the format per line, not once at import", () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("scheduler");

    log.info("tick", { due: 2 });
    expect(info.mock.calls[0][0]).toBe("[scheduler] tick due=2");

    // Same logger instance, format flipped underneath it: this is what makes
    // the knob work for a module graph that loaded before the env was read.
    process.env.CALANDRIA_LOG_FORMAT = "json";
    log.warn("slow", { ms: 90 });
    log.error("dead");
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({ level: "warn", component: "scheduler", msg: "slow", ms: 90 });
    expect(JSON.parse(error.mock.calls[0][0] as string)).toMatchObject({ level: "error", msg: "dead" });
    // stdout/stderr split is unchanged by the format, so an existing 2> redirect
    // keeps meaning the same thing.
    expect(info).toHaveBeenCalledTimes(1);
  });
});
