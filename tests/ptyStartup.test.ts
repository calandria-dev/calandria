/* A failed PTY spawn must close the already-upgraded WebSocket cleanly. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { DETACHED, TEST_SHELL, killChildTree } from "./platform";

const ROOT = path.resolve(__dirname, "..");
const HOST = "127.0.0.1";
const WAIT_MS = 10_000;

type ControlMessage = { type?: string; cwd?: string; exitCode?: number };
type CloseResult = { code: number; reason: string };
type Handshake =
  | { kind: "open"; statusCode: number | null }
  | { kind: "rejected"; statusCode: number; upgraded: boolean }
  | { kind: "error"; error: Error }
  | { kind: "timeout" };

type Attempt = {
  ws: WebSocket;
  handshake: Promise<Handshake>;
  closed: Promise<CloseResult>;
  messages: ControlMessage[];
  errors: Error[];
  waitForMessage: (type: string) => Promise<ControlMessage>;
};

let sidecar: ChildProcess | null = null;
let sidecarStderr = "";
let tempDir = "";
let port = 0;
let spawnCountPath = "";

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => resolve());
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function attemptSocket(origin: string): Attempt {
  const ws = new WebSocket(`ws://${HOST}:${port}/?cols=80&rows=24`, {
    headers: { Origin: origin },
    perMessageDeflate: false,
  });
  const messages: ControlMessage[] = [];
  const errors: Error[] = [];
  const waiters = new Map<string, Array<(message: ControlMessage) => void>>();
  let upgraded = false;
  let statusCode: number | null = null;
  let handshakeSettled = false;
  let resolveHandshake!: (result: Handshake) => void;
  const handshake = new Promise<Handshake>((resolve) => { resolveHandshake = resolve; });
  const settleHandshake = (result: Handshake) => {
    if (handshakeSettled) return;
    handshakeSettled = true;
    clearTimeout(handshakeTimer);
    resolveHandshake(result);
  };
  const handshakeTimer = setTimeout(() => {
    settleHandshake({ kind: "timeout" });
    ws.terminate();
  }, WAIT_MS);
  const closed = new Promise<CloseResult>((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });

  ws.once("upgrade", (response) => {
    upgraded = true;
    statusCode = response.statusCode ?? null;
  });
  ws.once("open", () => settleHandshake({ kind: "open", statusCode }));
  ws.once("unexpected-response", (_request, response) => {
    const rejectedStatus = response.statusCode ?? 0;
    response.once("end", () => response.socket?.destroy());
    response.resume();
    settleHandshake({ kind: "rejected", statusCode: rejectedStatus, upgraded });
  });
  ws.on("error", (error) => {
    errors.push(error);
    settleHandshake({ kind: "error", error });
  });
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let message: ControlMessage;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    messages.push(message);
    for (const waiter of waiters.get(message.type || "") || []) waiter(message);
    waiters.delete(message.type || "");
  });

  return {
    ws,
    handshake,
    closed,
    messages,
    errors,
    waitForMessage(type) {
      const existing = messages.find((message) => message.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const list = waiters.get(type) || [];
        list.push(resolve);
        waiters.set(type, list);
      });
    },
  };
}

function within<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), WAIT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function spawnCount(): number {
  try { return Number(fs.readFileSync(spawnCountPath, "utf8")); } catch { return 0; }
}

async function waitForSidecar(): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (sidecar?.exitCode !== null && sidecar?.exitCode !== undefined) {
      throw new Error(`PTY sidecar exited early (${sidecar.exitCode}): ${sidecarStderr}`);
    }
    try {
      const response = await fetch(`http://${HOST}:${port}/`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.text()) === "calandria pty-server") return;
      lastError = `unexpected health response ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`PTY sidecar did not become ready: ${lastError}\n${sidecarStderr}`);
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-pty-startup-"));
  const preloadPath = path.join(tempDir, "fail-first-pty-spawn.cjs");
  spawnCountPath = path.join(tempDir, "spawn-count");
  fs.writeFileSync(preloadPath, `
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const fromProject = Module.createRequire(path.join(process.cwd(), "package.json"));
const realPty = fromProject("node-pty");
const counter = ${JSON.stringify(spawnCountPath)};
const originalSpawn = realPty.spawn;
let count = 0;
realPty.spawn = (...args) => {
  fs.writeFileSync(counter, String(++count));
  if (count === 1) throw new Error("Invalid pty handle");
  return originalSpawn(...args);
};
`);

  port = await reserveLoopbackPort();
  sidecar = spawn(process.execPath, ["--require", preloadPath, path.join(ROOT, "pty-server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PTY_PORT: String(port),
      PTY_HOST: HOST,
      CALANDRIA_PTY_SHELL: TEST_SHELL,
      CF_ACCESS_TEAM_DOMAIN: undefined,
      CF_ACCESS_AUD: undefined,
      PUBLIC_BASE_URL: "",
      CALANDRIA_ALLOWED_ORIGINS: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
    detached: DETACHED,
  });
  sidecar.stderr?.on("data", (chunk: Buffer) => {
    sidecarStderr = `${sidecarStderr}${chunk.toString("utf8")}`.slice(-16 * 1024);
  });
  await waitForSidecar();
}, 20_000);

afterAll(() => {
  killChildTree(sidecar);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

it("contains a post-upgrade PTY startup failure and serves the next session", async () => {
  const sockets: WebSocket[] = [];
  const connect = (origin: string): Attempt => {
    const attempt = attemptSocket(origin);
    sockets.push(attempt.ws);
    return attempt;
  };

  try {
    const refused = connect("http://evil.example");
    const refusedResult = await within(refused.handshake, "cross-origin refusal");
    expect(refusedResult).toEqual({ kind: "rejected", statusCode: 401, upgraded: false });
    expect(spawnCount()).toBe(0);

    const failed = connect(`http://${HOST}:${port}`);
    const failedHandshake = await within(failed.handshake, "authorized WebSocket upgrade");
    expect(failedHandshake).toEqual({ kind: "open", statusCode: 101 });
    const failedClose = await within(failed.closed, "terminal startup failure close");
    expect(failed.messages.some((message) => message.type === "ready")).toBe(false);
    expect(failedClose).toEqual({ code: 1011, reason: "Terminal startup failed" });
    expect(failed.errors).toEqual([]);
    expect(spawnCount()).toBe(1);

    const working = connect(`http://${HOST}:${port}`);
    const workingHandshake = await within(working.handshake, "next authorized WebSocket upgrade");
    expect(workingHandshake).toEqual({ kind: "open", statusCode: 101 });
    const ready = await within(working.waitForMessage("ready"), "PTY ready frame");
    expect(typeof ready.cwd).toBe("string");
    expect(spawnCount()).toBe(2);

    working.ws.send(JSON.stringify({ type: "input", data: "exit\r" }));
    const exit = await within(working.waitForMessage("exit"), "shell exit frame");
    expect(exit.exitCode).toBe(0);
    await within(working.closed, "graceful WebSocket close");
    expect(working.errors).toEqual([]);
    expect(sidecar?.exitCode).toBeNull();
    const health = await fetch(`http://${HOST}:${port}/`, { signal: AbortSignal.timeout(WAIT_MS) });
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("calandria pty-server");
  } finally {
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
  }
});
