import { describe, it, expect } from "vitest";
import { summarizeFailure, clipKeepTail } from "@/lib/agents/shared";

// A failed tool result is explained at its END: the CLI prefixes "Exit code N"
// and the shell appends stderr after stdout. Both the peek and the clip have
// to keep that tail, or a long failed command renders as good-looking output
// under a red ✗ with nothing that says why (the "error banner" bug).

describe("summarizeFailure", () => {
  it("lifts the Claude CLI's exit line into the label and peeks the last lines", () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const raw = `Exit code 1\n${body}\ncat: b.txt: No such file or directory\n`;
    const peek = summarizeFailure(raw);
    expect(peek).toEqual({
      kind: "fail",
      label: "Exit code 1",
      lines: ["line 16", "line 17", "line 18", "line 19", "line 20", "cat: b.txt: No such file or directory"],
      omitted: 15,
    });
  });

  it("takes the exit status as a parameter when the output doesn't carry it (Codex)", () => {
    expect(summarizeFailure("boom\n", 2)).toEqual({ kind: "fail", label: "Exit code 2", lines: ["boom"], omitted: 0 });
    // A zero exit with status "failed" is a failure without a status line.
    expect(summarizeFailure("boom", 0)).toEqual({ kind: "fail", label: undefined, lines: ["boom"], omitted: 0 });
    expect(summarizeFailure("boom", null)).toEqual({ kind: "fail", label: undefined, lines: ["boom"], omitted: 0 });
  });

  it("has no label for a plain error message, and no crash on empty output", () => {
    expect(summarizeFailure("File does not exist.")).toEqual({ kind: "fail", label: undefined, lines: ["File does not exist."], omitted: 0 });
    expect(summarizeFailure("")).toEqual({ kind: "fail", label: undefined, lines: [], omitted: 0 });
    // Only the exit line, nothing after it (a silent `grep` with no match).
    expect(summarizeFailure("Exit code 1\n")).toEqual({ kind: "fail", label: "Exit code 1", lines: [], omitted: 0 });
  });

  it("does not mistake a mid-output 'Exit code' for the status", () => {
    const peek = summarizeFailure("something\nExit code 3\n");
    expect(peek.kind === "fail" && peek.label).toBeUndefined();
  });
});

describe("clipKeepTail", () => {
  it("passes short text through untouched", () => {
    expect(clipKeepTail("hello", 6000)).toBe("hello");
    expect(clipKeepTail("x".repeat(6000), 6000)).toBe("x".repeat(6000));
  });

  it("keeps both the head (exit status) and the tail (the reason) of a long failure", () => {
    const filler = "0123456789".repeat(1000); // 10k chars
    const raw = `Exit code 1\n${filler}\ncat: b.txt: No such file or directory`;
    const out = clipKeepTail(raw, 6000);
    expect(out.startsWith("Exit code 1\n")).toBe(true);
    expect(out.endsWith("cat: b.txt: No such file or directory")).toBe(true);
    expect(out).toContain(`… (${raw.length - 6000} chars omitted) …`);
    // Bounded: the kept text is exactly n chars plus the marker line.
    expect(out.length).toBeLessThan(6000 + 60);
  });
});
