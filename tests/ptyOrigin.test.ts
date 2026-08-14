/* The pty sidecar's own gate, exercised against the real process.
 *
 * tests/sameOrigin.test.ts pins the RULE; this pins the WIRING — that
 * pty-server.js actually consults it before spawning a shell. Worth a real
 * process because the failure mode is silent and total: an unguarded sidecar
 * hands a shell to anyone who completes a handshake, and every unit test in the
 * world still passes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import WebSocket from "ws";

const ROOT = path.resolve(__dirname, "..");
const PORT = 3947; // fixed but unusual; the suite is serial so nothing contends
const ACCESS_PORT = 3948; // the Cloudflare Access-mode sidecar, below

let sidecar: ChildProcess;

/**
 * Resolve to the handshake outcome: "open" (shell granted) or the refusal.
 * An accepted handshake spawns a REAL shell, so wait for the socket to finish
 * closing before resolving — the sidecar kills the pty on 'close', and
 * resolving early lets afterAll tear the process down first, orphaning shells.
 */
function connect(origin?: string, port = PORT, host?: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?cols=80&rows=24`, {
      headers: { ...(origin ? { Origin: origin } : {}), ...(host ? { Host: host } : {}) },
    });
    const done = (outcome: string) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve(outcome);
      ws.once("close", () => resolve(outcome));
      try { ws.close(); } catch { resolve(outcome); }
    };
    ws.on("open", () => done("open"));
    ws.on("unexpected-response", (_req, res) => done(`rejected:${res.statusCode}`));
    ws.on("error", (err) => done(`error:${err.message}`));
  });
}

beforeAll(async () => {
  // Own the whole process group: the sidecar's accepted connections are real
  // pty children, and killing only the parent would orphan them onto the
  // developer's machine.
  sidecar = spawn(process.execPath, [path.join(ROOT, "pty-server.js")], {
    cwd: ROOT,
    env: { ...process.env, PTY_PORT: String(PORT), PTY_HOST: "127.0.0.1", SHELL: "/bin/sh" },
    stdio: "ignore",
    detached: true,
  });
  // Wait for the listener rather than sleeping a fixed amount.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const outcome = await connect("http://127.0.0.1:" + PORT);
    if (outcome === "open") return;
    if (Date.now() > deadline) throw new Error(`sidecar never came up (last: ${outcome})`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 20_000);

afterAll(() => {
  // Negative pid = the group, so any pty child goes with it.
  if (sidecar?.pid) {
    try { process.kill(-sidecar.pid, "SIGKILL"); } catch { try { sidecar.kill("SIGKILL"); } catch {} }
  }
});

describe("pty sidecar handshake", () => {
  it("refuses a foreign origin instead of spawning a shell", async () => {
    expect(await connect("http://evil.example")).toBe("rejected:401");
  });

  it("refuses the opaque null origin", async () => {
    expect(await connect("null")).toBe("rejected:401");
  });

  it("still serves the app's own origin", async () => {
    expect(await connect(`http://127.0.0.1:${PORT}`)).toBe("open");
  });

  // Stricter than the HTTP gate on purpose, and worth pinning because it is a
  // deliberate asymmetry someone will otherwise "fix" later: HTTP lets an
  // absent Origin through (curl, health probes, the MCP bridge all omit it),
  // but /pty is an interactive shell and every browser sends Origin on a
  // WebSocket handshake. So the only callers this turns away are non-browsers,
  // which have no business opening a terminal.
  it("refuses a handshake with no Origin at all", async () => {
    expect(await connect(undefined)).toBe("rejected:401");
  });
});

/* The same wiring under Cloudflare Access, where the sidecar must apply a
 * DIFFERENT policy — see tests/localOrigin.test.ts for the rule itself.
 *
 * We can't mint a real assertion here (that needs the team's signing keys), so
 * every handshake below is refused. What's worth pinning is WHICH check refused
 * it, because the bug this replaced was a refusal by the wrong one: the sidecar
 * applied local mode's Host allowlist, the tunnel hostname was never in it, and
 * the terminal was dead on any Access deployment with PUBLIC_BASE_URL empty.
 * So we read the sidecar's own log line.
 */
describe("pty sidecar handshake under Cloudflare Access", () => {
  let accessSidecar: ChildProcess;
  let stderr = "";

  /** The reason the sidecar logged for the most recent refusal. */
  async function refusalReason(origin?: string, host?: string): Promise<string> {
    stderr = "";
    const outcome = await connect(origin, ACCESS_PORT, host);
    // console.warn lands on stderr asynchronously relative to the socket close.
    for (let i = 0; i < 50 && !stderr.includes("rejected"); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return `${outcome} ${stderr.trim()}`;
  }

  beforeAll(async () => {
    accessSidecar = spawn(process.execPath, [path.join(ROOT, "pty-server.js")], {
      cwd: ROOT,
      env: {
        ...process.env,
        PTY_PORT: String(ACCESS_PORT),
        PTY_HOST: "127.0.0.1",
        SHELL: "/bin/sh",
        // Enforcement is on iff BOTH are set. Never contacted: an absent
        // assertion is rejected before any JWKS fetch.
        CF_ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
        CF_ACCESS_AUD: "test-aud",
        // Deliberately empty — the documented default, and the whole point.
        PUBLIC_BASE_URL: "",
        ORCH_ALLOWED_ORIGINS: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    accessSidecar.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    // No handshake can succeed here, so readiness is the plain HTTP listener.
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${ACCESS_PORT}/`);
        if (res.ok) { await res.text(); break; }
      } catch {}
      if (Date.now() > deadline) throw new Error("access-mode sidecar never came up");
      await new Promise((r) => setTimeout(r, 150));
    }
    stderr = "";
  }, 20_000);

  afterAll(() => {
    if (accessSidecar?.pid) {
      try { process.kill(-accessSidecar.pid, "SIGKILL"); } catch { try { accessSidecar.kill("SIGKILL"); } catch {} }
    }
  });

  it("stops rejecting the tunnel hostname for being unlisted", async () => {
    // THE regression. Same-origin against a hostname in no allowlist now gets
    // past the origin gate and fails on the missing assertion instead — which
    // is the check that should be deciding in this mode.
    const reason = await refusalReason("https://orch.example.com", "orch.example.com");
    expect(reason).toContain("rejected:401");
    expect(reason).toContain("no valid Access assertion");
    expect(reason).not.toContain("does not match host");
  });

  it("still refuses a cross-site handshake before it ever looks at the JWT", async () => {
    // Cross-site WebSocket hijacking: the Access cookie is SameSite=None, so a
    // valid assertion proves identity but not intent. Origin is what proves it.
    const reason = await refusalReason("https://evil.example", "orch.example.com");
    expect(reason).toContain("rejected:401");
    expect(reason).toContain("does not match host");
    expect(reason).not.toContain("no valid Access assertion");
  });

  it("still refuses a handshake with no Origin at all", async () => {
    const reason = await refusalReason(undefined, "orch.example.com");
    expect(reason).toContain("rejected:401");
    expect(reason).toContain("does not match host");
  });

  it("still refuses loopback callers that found PTY_PORT without an assertion", async () => {
    const reason = await refusalReason(`http://127.0.0.1:${ACCESS_PORT}`);
    expect(reason).toContain("rejected:401");
    expect(reason).toContain("no valid Access assertion");
  });
});
