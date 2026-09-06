// The client-side half of tool_output_delta: growing a running command's peek
// one fragment at a time. Pure, so it is tested here rather than in the
// browser. The e2e proves that the row on screen actually grows.
import { describe, it, expect } from "vitest";
import { growOutputPeek, LIVE_OUTPUT_LINES, LIVE_OUTPUT_LINE_CHARS } from "@/app/shell/format";
import type { ToolPeek } from "@/lib/types";

const grow = (deltas: string[], from?: ToolPeek) => deltas.reduce<ToolPeek | undefined>((p, d) => growOutputPeek(p, d), from);
const linesOf = (p: ToolPeek | undefined) => (p?.kind === "lines" ? p.lines : null);

describe("growOutputPeek", () => {
  it("continues the partial last line rather than starting a new one", () => {
    // A fragment almost never ends on a line boundary: the pty hands over
    // whatever was in the buffer.
    expect(linesOf(grow(["Runn", "ing tests\nok"]))).toEqual(["Running tests", "ok"]);
  });

  it("keeps the trailing empty line a final newline leaves", () => {
    // Both because the next fragment continues it and because the settled
    // summarizeResult("output") peek carries the same one.
    expect(linesOf(grow(["done\n"]))).toEqual(["done", ""]);
    expect(linesOf(grow(["more"], grow(["done\n"])))).toEqual(["done", "more"]);
  });

  it("keeps the TAIL when the output outruns the cap", () => {
    // A four-minute build is interesting at its end, and the settled peek
    // replaces this the moment the command finishes.
    const out = grow(["1\n2\n3\n4\n5\n6\n7\n8\n9\n"]);
    expect(linesOf(out)).toHaveLength(LIVE_OUTPUT_LINES);
    expect(linesOf(out)).toEqual(["5", "6", "7", "8", "9", ""]);
  });

  it("bounds a single line that never breaks", () => {
    // A progress bar or a minified bundle on stdout would otherwise grow one
    // string in React state without limit.
    const huge = "x".repeat(LIVE_OUTPUT_LINE_CHARS * 3);
    const out = grow([huge, "END"]);
    expect(linesOf(out)![0]).toHaveLength(LIVE_OUTPUT_LINE_CHARS);
    expect(linesOf(out)![0].endsWith("END")).toBe(true);
  });

  it("treats a bare carriage return as a break", () => {
    // A spinner rewrites its own line; keeping the last few states of it beats
    // one line that grows forever.
    expect(linesOf(grow(["10%\r20%\r30%\r\ndone"]))).toEqual(["10%", "20%", "30%", "done"]);
  });

  it("never overwrites a peek belonging to a different kind of tool", () => {
    // A stray fragment aimed at a diff or a checklist starts a fresh lines
    // peek instead of clobbering what is there.
    const todos: ToolPeek = { kind: "todos", items: [{ text: "a", status: "pending" }] };
    expect(linesOf(growOutputPeek(todos, "hello"))).toEqual(["hello"]);
  });
});
