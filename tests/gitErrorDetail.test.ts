import { describe, it, expect } from "vitest";
import { gitErrorLine, gitErrorDetail } from "../lib/git";

// A failed git subprocess error the way `execFile`'s promisified wrapper
// rejects with (the shape gitErrorLine/gitErrorDetail read `stderr` off).
function subprocessError(stderr: string): unknown {
  return Object.assign(new Error("Command failed"), { stderr });
}

describe("gitErrorLine / gitErrorDetail — push rejections", () => {
  it("distinguishes a pre-push hook rejection: headline names the hook, detail keeps its output", () => {
    const stderr = [
      "gate: running pre-push checks...",
      "gate: lint failed",
      "error: failed to push some refs to 'git@github.com:x/y.git'",
    ].join("\n");
    const e = subprocessError(stderr);

    expect(gitErrorLine(e, "git push failed")).toBe("push rejected by a pre-push hook");

    const detail = gitErrorDetail(e);
    expect(detail).toContain("gate: running pre-push checks...");
    expect(detail).toContain("gate: lint failed");
    expect(detail).not.toContain("error: failed to push");
  });

  it("prefers the [rejected] line for a non-fast-forward rejection, and drops hint: lines from detail", () => {
    const stderr = [
      "To github.com:x/y.git",
      " ! [rejected]        main -> main (fetch first)",
      "error: failed to push some refs to 'github.com:x/y.git'",
      "hint: Updates were rejected because the remote contains work that you do not",
      "hint: have locally…",
    ].join("\n");
    const e = subprocessError(stderr);

    const headline = gitErrorLine(e, "git push failed");
    expect(headline).toContain("[rejected]");
    expect(headline).toContain("fetch first");

    const detail = gitErrorDetail(e);
    expect(detail).not.toMatch(/hint:/i);
    expect(detail).not.toContain("error: failed to push");
    expect(detail).not.toContain("To github.com:x/y.git");
  });

  it("treats [remote rejected] (a pre-receive hook) like [rejected], keeping remote: lines with the prefix stripped", () => {
    const stderr = [
      "remote: ",
      "remote: ERROR: Pre-receive hook declined",
      "remote: ",
      "To github.com:x/y.git",
      " ! [remote rejected] main -> main (pre-receive hook declined)",
      "error: failed to push some refs to 'github.com:x/y.git'",
    ].join("\n");
    const e = subprocessError(stderr);

    const headline = gitErrorLine(e, "git push failed");
    expect(headline).toContain("[remote rejected]");

    const detail = gitErrorDetail(e);
    expect(detail).toContain("ERROR: Pre-receive hook declined");
    expect(detail).not.toMatch(/^remote:/m); // prefix stripped, not left on the line
    expect(detail).not.toContain("error: failed to push");
    // The empty "remote:" separator lines contribute nothing and are dropped.
    expect(detail.split("\n").every((l) => l.trim().length > 0)).toBe(true);
  });

  it("falls back to the Error's message when there is no stderr to read", () => {
    const e = new Error("spawn git ENOENT");
    expect(gitErrorLine(e, "git push failed")).toBe("spawn git ENOENT");
    expect(gitErrorDetail(e)).toBe("");
  });

  it("returns empty detail when stderr only contained boilerplate", () => {
    const stderr = [
      "To github.com:x/y.git",
      "error: failed to push some refs to 'github.com:x/y.git'",
      "hint: Updates were rejected because the tip of your current branch is behind",
    ].join("\n");
    const e = subprocessError(stderr);
    expect(gitErrorDetail(e)).toBe("");
  });

  it("caps detail at 40 lines and appends an ellipsis when truncated", () => {
    const hookLines = Array.from({ length: 60 }, (_, i) => `gate: check ${i} failed`);
    const stderr = [...hookLines, "error: failed to push some refs to 'github.com:x/y.git'"].join("\n");
    const e = subprocessError(stderr);

    const detail = gitErrorDetail(e);
    const lines = detail.split("\n");
    // Last line carries the trailing ellipsis appended after truncation.
    expect(lines.length).toBe(40);
    expect(lines[0]).toBe("gate: check 0 failed");
    expect(detail.endsWith("…")).toBe(true);
  });

  it("caps detail at 4000 characters and appends an ellipsis when truncated", () => {
    const longLine = "gate: " + "x".repeat(5000);
    const stderr = [longLine, "error: failed to push some refs to 'github.com:x/y.git'"].join("\n");
    const e = subprocessError(stderr);

    const detail = gitErrorDetail(e);
    expect(detail.length).toBeLessThanOrEqual(4001); // 4000 chars + the ellipsis char
    expect(detail.endsWith("…")).toBe(true);
  });
});
