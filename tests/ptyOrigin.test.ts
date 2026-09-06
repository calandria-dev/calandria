/* The pty sidecar's own gate, exercised against the real process.
 *
 * tests/sameOrigin.test.ts pins the rule; this pins the wiring: that
 * pty-server.js consults it before spawning a shell. This runs against a real
 * process because an unguarded sidecar hands a shell to anyone who completes
 * a handshake, and no unit test would catch that.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import WebSocket from "ws";
import { DETACHED, TEST_SHELL, killChildTree } from "./platform";

const ROOT = path.resolve(__dirname, "..");
const PORT = 3947; // fixed but unusual; the suite is serial so nothing contends
const ACCESS_PORT = 3948; // the Cloudflare Access-mode sidecar, below

let sidecar: ChildProcess;

/**
 * Resolve to the handshake outcome: "open" (shell granted) or the refusal.
 * An accepted handshake spawns a real shell, so this waits for the socket to
 * finish closing before resolving. The sidecar kills the pty on 'close', and
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
  // Own the whole tree: the sidecar's accepted connections are real pty
  // children, and killing only the parent would orphan them onto the
  // developer's machine. On POSIX that means its own process group; win32 has
  // none, and killChildTree() handles the difference (lib/processTree.ts).
  sidecar = spawn(process.execPath, [path.join(ROOT, "pty-server.js")], {
    cwd: ROOT,
    // The CALANDRIA_PTY_SHELL knob picks the shell here; $SHELL is only the
    // sidecar's fallback (tests/platform.ts), and this file needs a shell
    // that actually exists.
    env: { ...process.env, PTY_PORT: String(PORT), PTY_HOST: "127.0.0.1", CALANDRIA_PTY_SHELL: TEST_SHELL },
    stdio: "ignore",
    detached: DETACHED,
  });
  // Poll for the listener instead of sleeping a fixed amount.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const outcome = await connect("http://127.0.0.1:" + PORT);
    if (outcome === "open") return;
    if (Date.now() > deadline) throw new Error(`sidecar never came up (last: ${outcome})`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 20_000);

afterAll(() => {
  killChildTree(sidecar);
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

  // Stricter than the HTTP gate: HTTP allows an absent Origin (curl, health
  // probes, the MCP bridge all omit it), but /pty is an interactive shell and
  // every browser sends Origin on a WebSocket handshake, so only non-browser
  // callers are turned away here.
  it("refuses a handshake with no Origin at all", async () => {
    expect(await connect(undefined)).toBe("rejected:401");
  });
});

/* The same wiring under Cloudflare Access, where the sidecar applies a
 * different policy: see tests/localOrigin.test.ts for the rule itself.
 *
 * No real assertion can be minted here (that needs the team's signing keys),
 * so every handshake below is refused. What matters is which check refused
 * it, so each case also reads the sidecar's own log line.
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
        CALANDRIA_PTY_SHELL: TEST_SHELL,
        // Enforcement is on iff BOTH are set. Never contacted: an absent
        // assertion is rejected before any JWKS fetch.
        CF_ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
        CF_ACCESS_AUD: "test-aud",
        // Empty is the documented default.
        PUBLIC_BASE_URL: "",
        CALANDRIA_ALLOWED_ORIGINS: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
      detached: DETACHED,
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
    killChildTree(accessSidecar);
  });

  it("stops rejecting the tunnel hostname for being unlisted", async () => {
    // Same-origin against a hostname in no allowlist passes the origin gate
    // and fails on the missing assertion instead, which is the check that
    // should decide in this mode.
    const reason = await refusalReason("https://calandria.example.com", "calandria.example.com");
    expect(reason).toContain("rejected:401");
    expect(reason).toContain("no valid Access assertion");
    expect(reason).not.toContain("does not match host");
  });

  it("still refuses a cross-site handshake before it ever looks at the JWT", async () => {
    // Cross-site WebSocket hijacking: the Access cookie is SameSite=None, so a
    // valid assertion proves identity but not intent. Origin is what proves it.
    const reason = await refusalReason("https://evil.example", "calandria.example.com");
    expect(reason).toContain("rejected:401");
    expect(reason).toContain("does not match host");
    expect(reason).not.toContain("no valid Access assertion");
  });

  it("still refuses a handshake with no Origin at all", async () => {
    const reason = await refusalReason(undefined, "calandria.example.com");
    expect(reason).toContain("rejected:401");
    expect(reason).toContain("does not match host");
  });

  it("still refuses loopback callers that found PTY_PORT without an assertion", async () => {
    const reason = await refusalReason(`http://127.0.0.1:${ACCESS_PORT}`);
    expect(reason).toContain("rejected:401");
    expect(reason).toContain("no valid Access assertion");
  });
});
