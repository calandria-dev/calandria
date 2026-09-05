/* The desktop app's SSH transport: a local port forwarded to a remote
 * Calandria. See docs/DESKTOP_APP.md.
 *
 * An `ssh` instance is a `url` instance whose origin does not exist yet.
 * This file makes `http://127.0.0.1:<localPort>` real by running
 *
 *   ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes \
 *       -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort> <host>
 *
 * and waiting for that port to accept a connection; main.js then proceeds as
 * it does for any `url` instance.
 *
 * Uses the user's own `ssh` binary, so their config, agent, jump hosts,
 * ControlMaster sockets and hardware keys work unchanged. `BatchMode=yes`
 * follows: a GUI has no terminal for a password or 2FA code, so a host that
 * wants one must be told to set up a key or a ControlMaster session instead
 * of hanging at an invisible prompt (see `sshFailureMessage`).
 *
 * No `electron` require, so the risky half is verifiable from
 * `node desktop/test-supervisor.js` with no display; main.js holds the
 * Electron half.
 */
"use strict";

const net = require("node:net");
const { spawn } = require("node:child_process");

/**
 * Where a forwarded port is looked for first.
 *
 * Scans from a fixed base instead of binding :0. The window's origin is
 * `http://127.0.0.1:<localPort>`, and the web UI keeps per-origin state in
 * localStorage, so a port that moves on every launch resets the user's
 * theme and selection on every attach. The same base keeps the same origin
 * in the ordinary case.
 */
const LOCAL_PORT_BASE = 3100;

/** The port a Calandria listens on when nobody said otherwise (server.js). */
const DEFAULT_REMOTE_PORT = 3000;

/** How long a forward gets to come up before the attach is called a failure. */
const CONNECT_TIMEOUT_MS = 20_000;

/** The reconnect schedule, matching notifier.js's stream backoff. */
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;

/** How many lines of ssh's stderr are worth showing. */
const STDERR_LINES = 12;

/** The ssh binary. Overridable so a test (or an odd install) can point elsewhere. */
function sshBinary(env = process.env) {
  return env.CALANDRIA_SSH || "ssh";
}

/**
 * The argument vector. See docs/DESKTOP_APP.md.
 *
 * `-N` because there is no command to run, only the forward. Both ends of
 * `-L` are pinned to `127.0.0.1`: the local half so the forward is not
 * offered to the LAN, and the remote half because the server there is bound
 * to loopback in local mode, making SSH itself the credential instead of an
 * added origin allowlist entry.
 *
 * `ExitOnForwardFailure=yes` is what makes the wait below terminate: without
 * it, an ssh whose local port is already taken stays up forever with no
 * forward, and "connected" would mean nothing.
 */
function sshArgs({ host, localPort, remotePort }) {
  return [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "BatchMode=yes",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    host,
  ];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function portFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/** Is anything accepting connections there right now? */
function portAccepts(port, { host = "127.0.0.1", timeoutMs = 1_000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Wait for the forwarded port to accept a connection.
 *
 * Accepting a connection is not proof the far end is a Calandria (ssh
 * accepts locally, then opens the channel), but it is proof the forward
 * exists; the `/api/version` handshake main.js runs next checks the rest.
 * The abort signal lets a child that dies mid-wait cut this short instead of
 * leaving the user watching a spinner for the whole timeout.
 */
async function waitForPort(port, { host = "127.0.0.1", timeoutMs = CONNECT_TIMEOUT_MS, intervalMs = 100, signal = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error("the wait for the forwarded port was cancelled");
    if (await portAccepts(port, { host, timeoutMs: 1_000 })) return true;
    if (signal?.aborted) throw new Error("the wait for the forwarded port was cancelled");
    if (Date.now() >= deadline) {
      throw new Error(`nothing accepted a connection on ${host}:${port} within ${Math.round(timeoutMs / 1000)}s`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Choose the local end of the forward.
 *
 * A port the user configured is honoured or refused, never stepped past:
 * forwarding somewhere else without telling them is worse than reporting the
 * port as busy. An unconfigured port scans from LOCAL_PORT_BASE.
 */
async function pickLocalPort(preferred = 0, { base = LOCAL_PORT_BASE, probes = 40 } = {}) {
  if (preferred) {
    if (await portFree(preferred)) return preferred;
    throw new Error(
      `Local port ${preferred} is already in use. Choose another in instances.json, or remove localPort to let the app pick one.`,
    );
  }
  for (let i = 0; i < probes; i++) {
    if (await portFree(base + i)) return base + i;
  }
  throw new Error(`No free local port between ${base} and ${base + probes - 1} to forward through.`);
}

/**
 * What to tell someone whose forward did not come up.
 *
 * The BatchMode sentence appears on every case except a missing binary: the
 * most likely reason a working `ssh host` in a terminal fails here is that
 * it asked for something, and this app has no way to let the user answer.
 */
function sshFailureMessage({
  host,
  code = null,
  signal = null,
  stderr = [],
  timedOut = false,
  spawnError = null,
  dropped = false,
}) {
  if (spawnError && !dropped) {
    return `Could not run ssh (${spawnError}). Install an OpenSSH client, or point CALANDRIA_SSH at one.`;
  }
  const tail = stderr.length ? `\n\n${stderr.join("\n")}` : "";
  // A forward that WAS up gets no BatchMode advice: authentication demonstrably
  // worked, so telling the user to set up a key is a wrong answer to a network
  // that went away.
  if (dropped) {
    const how = spawnError || (signal ? `killed by ${signal}` : `exit code ${code}`);
    return `The SSH connection to ${host} closed (${how}).${tail}`;
  }
  const hint =
    `\n\nThe desktop app runs ssh with BatchMode=yes, because a window has no terminal to type a password ` +
    `or a 2FA code into. Set up key authentication (ssh-copy-id ${host}) or leave a ControlMaster session ` +
    `open (ssh -fN ${host}), then try again.`;
  if (timedOut) {
    return `ssh did not open the forward to ${host} in time.${tail}${hint}`;
  }
  const how = signal ? `killed by ${signal}` : `exit code ${code}`;
  return `ssh to ${host} stopped (${how}) before the port forward came up.${tail}${hint}`;
}

/**
 * One forward, kept alive.
 *
 * `start()` makes exactly one attempt: the first failure is the one the user
 * must see and answer, landing on the boot screen's failure state with
 * Retry and Switch, the same place an unreachable `url` instance lands. Only
 * a forward that was once up reconnects on its own, with backoff, since by
 * then the app knows the host works and what changed is a laptop lid or a
 * network.
 *
 * The local port is chosen once and kept for the life of the tunnel, so a
 * reconnect returns to the same origin the window is already on instead of
 * making the page's session state disappear.
 */
class SshTunnel {
  constructor({
    host,
    remotePort = DEFAULT_REMOTE_PORT,
    localPort = 0,
    env = process.env,
    sshPath = null,
    spawnFn = spawn,
    onLog = () => {},
    onDown = () => {},
    onUp = () => {},
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    minBackoffMs = MIN_BACKOFF_MS,
    maxBackoffMs = MAX_BACKOFF_MS,
    stderrLines = STDERR_LINES,
    portBase = LOCAL_PORT_BASE,
  }) {
    this.host = host;
    this.remotePort = remotePort;
    this.wantedLocalPort = localPort;
    this.localPort = 0;
    this.env = env;
    this.sshPath = sshPath || sshBinary(env);
    this.spawnFn = spawnFn;
    this.onLog = onLog;
    this.onDown = onDown;
    this.onUp = onUp;
    this.connectTimeoutMs = connectTimeoutMs;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.stderrLines = stderrLines;
    this.portBase = portBase;
    this.child = null;
    this.stderr = [];
    this.stopped = false;
    this.up = false;
    this.attempts = 0;
    this.wake = null;
  }

  /** `http://127.0.0.1:<localPort>` once a port has been chosen, else null. */
  get url() {
    return this.localPort ? `http://127.0.0.1:${this.localPort}` : null;
  }

  /** The last lines ssh printed, newest last. */
  stderrTail(n = this.stderrLines) {
    return this.stderr.slice(-n);
  }

  /**
   * Bring the forward up once. Resolves `{ ok: true, url }` or
   * `{ ok: false, error, stderr }`. Never throws: every caller is a UI path
   * that displays the reason as a message.
   */
  async start() {
    try {
      this.localPort = await pickLocalPort(this.wantedLocalPort, { base: this.portBase });
    } catch (err) {
      return { ok: false, error: err?.message || String(err), stderr: [] };
    }
    const result = await this.attempt();
    if (!result.ok) await this.stop();
    return result;
  }

  /**
   * Spawn ssh and race the port against the child.
   *
   * Three outcomes, all decided here instead of by a timer firing later: the
   * port accepts (up), ssh exits first (its stderr is the explanation), or
   * neither happens before the deadline, meaning the forward is wedged and
   * gets killed, since a live ssh with no forward looks the same from
   * outside as a working one.
   */
  async attempt() {
    this.attempts += 1;
    this.stderr = [];
    const args = sshArgs({ host: this.host, localPort: this.localPort, remotePort: this.remotePort });
    this.onLog(`[shell] ssh ${args.join(" ")}`);
    let child;
    try {
      child = this.spawnFn(this.sshPath, args, { stdio: ["ignore", "pipe", "pipe"], env: this.env });
    } catch (err) {
      return { ok: false, error: sshFailureMessage({ host: this.host, spawnError: err?.message || String(err) }), stderr: [] };
    }
    this.child = child;

    const collect = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderr.push(line);
        if (this.stderr.length > this.stderrLines) this.stderr.shift();
        this.onLog(`[ssh] ${line}`);
      }
    };
    child.stderr?.on("data", collect);
    // ssh with -N says nothing on stdout, but a wrapper or a ProxyCommand
    // might, and a diagnostic that only exists on the wrong stream is a
    // diagnostic nobody sees.
    child.stdout?.on("data", collect);

    const ended = new AbortController();
    let exit = null;
    const exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        exit = { code, signal };
        ended.abort();
        resolve(exit);
      });
      // A binary that does not exist reports `error`, not `exit`.
      child.once("error", (err) => {
        exit = { spawnError: err?.message || String(err) };
        ended.abort();
        resolve(exit);
      });
    });

    let timedOut = false;
    try {
      await waitForPort(this.localPort, { timeoutMs: this.connectTimeoutMs, signal: ended.signal });
    } catch {
      timedOut = !exit;
    }

    if (exit || timedOut) {
      if (timedOut) {
        this.killChild(child);
        await Promise.race([exited, sleep(2_000)]);
      }
      this.child = null;
      const stderr = this.stderrTail();
      return {
        ok: false,
        error: sshFailureMessage({
          host: this.host,
          code: exit?.code ?? null,
          signal: exit?.signal ?? null,
          spawnError: exit?.spawnError ?? null,
          stderr,
          timedOut,
        }),
        stderr,
      };
    }

    this.up = true;
    // Armed only now: a child that exits during the race above is that
    // attempt's failure, not a drop, and reconnecting from there would loop
    // past the failure the user needs to read.
    void exited.then((ended_) => this.onChildGone(child, ended_));
    this.onLog(`[shell] ssh forward up: 127.0.0.1:${this.localPort} -> ${this.host}:${this.remotePort}`);
    return { ok: true, url: this.url };
  }

  /** The forward we had went away. Tell the caller, then keep trying. */
  onChildGone(child, exit) {
    if (this.stopped || this.child !== child || !this.up) return;
    this.up = false;
    this.child = null;
    const error = sshFailureMessage({
      host: this.host,
      code: exit?.code ?? null,
      signal: exit?.signal ?? null,
      spawnError: exit?.spawnError ?? null,
      stderr: this.stderrTail(),
      dropped: true,
    });
    void this.reconnect(error);
  }

  async reconnect(firstError) {
    let error = firstError;
    let delay = this.minBackoffMs;
    while (!this.stopped) {
      this.onDown({ error, stderr: this.stderrTail(), delayMs: delay });
      await this.pause(delay);
      if (this.stopped) return;
      const result = await this.attempt();
      if (result.ok) {
        this.onLog(`[shell] ssh forward to ${this.host} is back`);
        this.onUp({ url: this.url });
        return;
      }
      error = result.error;
      delay = Math.min(delay * 2, this.maxBackoffMs);
    }
  }

  /** A sleep `stop()` can cut short, so quitting never waits out a backoff. */
  pause(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  killChild(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  /**
   * Stop for good. Switching instances and quitting both come here, and both
   * mean the same thing: this forward has no window behind it any more.
   */
  async stop() {
    this.stopped = true;
    this.up = false;
    this.wake?.();
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    const gone = new Promise((resolve) => child.once("exit", resolve));
    this.killChild(child);
    const settled = await Promise.race([gone.then(() => true), sleep(2_000).then(() => false)]);
    if (!settled) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await Promise.race([gone, sleep(1_000)]);
    }
    this.onLog(`[shell] ssh forward to ${this.host} closed`);
  }
}

module.exports = {
  CONNECT_TIMEOUT_MS,
  DEFAULT_REMOTE_PORT,
  LOCAL_PORT_BASE,
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
  SshTunnel,
  pickLocalPort,
  portAccepts,
  sshArgs,
  sshBinary,
  sshFailureMessage,
  waitForPort,
};
