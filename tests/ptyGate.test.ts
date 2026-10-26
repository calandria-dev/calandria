import { describe, expect, it, vi } from "vitest";
import { ptyGateRefusalMessage, ptyGateVerdict } from "../lib/auth/pty-gate.mjs";
import * as localOrigin from "../lib/auth/local-origin.mjs";
import { diagnoseTerminalFailure, TERMINAL_MESSAGES } from "../app/terminalPreflight";

const localMode = { originAuthEnabled: () => false, verifyOriginNodeRequest: vi.fn() };
const accessMode = (valid: boolean) => ({
  originAuthEnabled: () => true,
  verifyOriginNodeRequest: vi.fn(async () => {
    if (!valid) throw new Error("no assertion");
    return {};
  }),
});
const req = (host: string, origin?: string) => ({ headers: { host, ...(origin ? { origin } : {}) } });

describe("pty gate verdict", () => {
  it("allows a loopback page in local mode", async () => {
    const v = await ptyGateVerdict(req("127.0.0.1:3000", "http://127.0.0.1:3000"), { cfAccess: localMode, localOrigin });
    expect(v).toEqual({ ok: true });
    expect(localMode.verifyOriginNodeRequest).not.toHaveBeenCalled();
  });

  it("names origin when local mode refuses a foreign page or an unknown host", async () => {
    const deps = { cfAccess: localMode, localOrigin };
    expect(await ptyGateVerdict(req("127.0.0.1:3000", "https://evil.example"), deps)).toEqual({ ok: false, reason: "origin" });
    expect(await ptyGateVerdict(req("rebound.example", "http://rebound.example"), deps)).toEqual({ ok: false, reason: "origin" });
    expect(await ptyGateVerdict(req("127.0.0.1:3000"), deps)).toEqual({ ok: false, reason: "origin" });
  });

  it("names origin in Access mode before checking the assertion", async () => {
    const cfAccess = accessMode(true);
    const v = await ptyGateVerdict(req("app.example", "https://evil.example"), { cfAccess, localOrigin });
    expect(v).toEqual({ ok: false, reason: "origin" });
    expect(cfAccess.verifyOriginNodeRequest).not.toHaveBeenCalled();
  });

  it("names access when a same-origin request carries no valid assertion", async () => {
    const v = await ptyGateVerdict(req("app.example", "https://app.example"), { cfAccess: accessMode(false), localOrigin });
    expect(v).toEqual({ ok: false, reason: "access" });
  });

  it("allows a same-origin request with a valid assertion", async () => {
    const v = await ptyGateVerdict(req("app.example", "https://app.example"), { cfAccess: accessMode(true), localOrigin });
    expect(v).toEqual({ ok: true });
  });

  it("logs a distinct line per reason", () => {
    expect(ptyGateRefusalMessage("access")).toMatch(/Access assertion/);
    expect(ptyGateRefusalMessage("origin")).toMatch(/origin/);
  });
});

describe("terminal failure diagnosis", () => {
  const respond = (init: { status: number; type?: ResponseType; redirected?: boolean; body?: unknown }) =>
    vi.fn(async () => {
      const res = new Response(init.body === undefined ? null : JSON.stringify(init.body), {
        status: init.status === 0 ? 200 : init.status,
      });
      return Object.defineProperties(res, {
        type: { value: init.type ?? "basic" },
        redirected: { value: init.redirected ?? false },
        status: { value: init.status },
        ok: { value: init.status >= 200 && init.status < 300 },
      });
    }) as unknown as typeof fetch;

  it("posts to the preflight route on the socket's base URL", async () => {
    const f = respond({ status: 200, body: { ok: true } });
    await diagnoseTerminalFailure("https://app.example", f);
    expect(f).toHaveBeenCalledWith("https://app.example/pty/preflight", expect.objectContaining({ method: "POST", redirect: "manual" }));
  });

  it("keeps the sidecar message when the server accepts the page", async () => {
    expect(await diagnoseTerminalFailure("", respond({ status: 200, body: { ok: true } }))).toBe("sidecar");
    expect(TERMINAL_MESSAGES.sidecar).toMatch(/pty-server sidecar running\? The server log names the reason/);
  });

  it("reports auth for a sign-in redirect, a proxy 401 and an Access refusal", async () => {
    expect(await diagnoseTerminalFailure("", respond({ status: 0, type: "opaqueredirect" }))).toBe("auth");
    expect(await diagnoseTerminalFailure("", respond({ status: 200, redirected: true }))).toBe("auth");
    expect(await diagnoseTerminalFailure("", respond({ status: 401 }))).toBe("auth");
    expect(await diagnoseTerminalFailure("", respond({ status: 403, body: { ok: false, reason: "access" } }))).toBe("auth");
    expect(TERMINAL_MESSAGES.auth).toContain("[terminal refused: not signed in to this instance, or the proxy blocked the WebSocket upgrade]");
  });

  it("reports origin when the server's gate names it", async () => {
    expect(await diagnoseTerminalFailure("", respond({ status: 403, body: { ok: false, reason: "origin" } }))).toBe("origin");
  });

  it("falls back to the generic message when the server cannot be reached", async () => {
    const f = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect(await diagnoseTerminalFailure("", f)).toBe("unknown");
    expect(await diagnoseTerminalFailure("", respond({ status: 502 }))).toBe("unknown");
  });
});
