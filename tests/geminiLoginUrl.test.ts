import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findAuthUrl } from "@/lib/agents/gemini/auth";

// `login-pty.bin` is the raw pty output of `agy` (1.2.17, 200 columns) from
// launch through choosing "Google OAuth", with the login abandoned before
// consent. The TUI hard-wraps the visible URL into fragments and puts the whole
// URL only in the OSC 8 hyperlink around each fragment. Every fragment lacks
// some of redirect_uri, state or scope, which Google answers with
// "Access blocked: Error 400 invalid_request".

const capture = readFileSync(path.join(__dirname, "fixtures/gemini/login-pty.bin"), "utf8");

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("findAuthUrl", () => {
  it("returns the whole authorize URL from the hyperlink target, not a wrapped fragment", () => {
    const url = findAuthUrl(capture);
    expect(url).not.toBeNull();
    const p = params(url!);
    expect(p.get("redirect_uri")).toBe("https://antigravity.google/oauth-callback");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")).toBeTruthy();
    expect(p.get("scope")).toContain("openid");
  });

  it("falls back to the longest plain-text match when there are no hyperlinks", () => {
    const full =
      "https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=https%3A%2F%2Fexample&state=abc";
    const text = `see https://accounts.google.com/o/oauth2/auth?client_id=x\r\n or ${full}\r\n`;
    expect(findAuthUrl(text)).toBe(full);
  });

  it("returns null when no authorize URL is present", () => {
    expect(findAuthUrl("\x1b[1mWelcome\x1b[m\r\n")).toBeNull();
  });
});
