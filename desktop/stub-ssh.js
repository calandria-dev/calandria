/* A fake `ssh` for desktop/test-supervisor.js — the same idea as stub-server.js.
 *
 * ssh-tunnel.js is a supervisor for somebody else's process, so the half worth
 * testing is what it does when that process misbehaves: refuses the key, comes
 * up and then dies, comes up and never listens. A real sshd cannot be asked for
 * those on demand (and a box with no sshd cannot be asked for anything), so the
 * tests point CALANDRIA_SSH at this and script the misbehaviour.
 *
 * It really does forward: `up` opens a TCP proxy from the local end of the `-L`
 * argument to the remote end, so a test can put a real HTTP server behind it and
 * check that the tunnel's URL reaches it, which is the one thing a stub that
 * only printed things could not show.
 *
 * Driven entirely by env, so the launcher script the test writes can stay two
 * lines:
 *
 *   STUB_SSH_PLAN       per-attempt behaviour, comma separated; the last entry
 *                       repeats. `up` forwards until killed, `up:<ms>` forwards
 *                       then exits 255, `fail` prints and exits 255, `hang`
 *                       stays alive without ever listening.
 *   STUB_SSH_COUNT_FILE where the attempt counter lives, so consecutive runs of
 *                       this script advance through the plan.
 *   STUB_SSH_ARGS_LOG   one JSON array of argv per run, appended.
 *   STUB_SSH_STDERR     what a `fail` prints. Defaults to what a host with no
 *                       key of yours says under BatchMode.
 */
"use strict";

const fs = require("node:fs");
const net = require("node:net");

const args = process.argv.slice(2);
if (process.env.STUB_SSH_ARGS_LOG) {
  fs.appendFileSync(process.env.STUB_SSH_ARGS_LOG, `${JSON.stringify(args)}\n`);
}

function attemptIndex() {
  const file = process.env.STUB_SSH_COUNT_FILE;
  if (!file) return 0;
  let n = 0;
  try {
    n = Number(fs.readFileSync(file, "utf8").trim()) || 0;
  } catch {
    n = 0;
  }
  fs.writeFileSync(file, String(n + 1));
  return n;
}

function step() {
  const plan = (process.env.STUB_SSH_PLAN || "up").split(",");
  const i = attemptIndex();
  return (plan[Math.min(i, plan.length - 1)] || "up").trim();
}

/** `127.0.0.1:<local>:127.0.0.1:<remote>` out of the -L argument. */
function ports() {
  const i = args.indexOf("-L");
  const spec = i === -1 ? "" : args[i + 1] || "";
  const parts = spec.split(":");
  return { local: Number(parts[1]), remote: Number(parts[3]) };
}

function die(message, code = 255) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const directive = step();
const [mode, arg] = directive.split(":");

if (mode === "fail") {
  die(process.env.STUB_SSH_STDERR || "me@stub: Permission denied (publickey,keyboard-interactive).");
} else if (mode === "hang") {
  // Alive, connected as far as anyone can tell, and forwarding nothing.
  setInterval(() => {}, 1_000);
} else {
  const { local, remote } = ports();
  const srv = net.createServer((sock) => {
    const up = net.connect({ port: remote, host: "127.0.0.1" });
    sock.on("error", () => up.destroy());
    up.on("error", () => sock.destroy());
    sock.pipe(up);
    up.pipe(sock);
  });
  srv.once("error", (err) => {
    // What ExitOnForwardFailure=yes turns into.
    die(`bind [127.0.0.1]:${local}: ${err.message}`);
  });
  srv.listen(local, "127.0.0.1", () => {
    const lifetime = Number(arg || 0);
    if (lifetime > 0) {
      setTimeout(() => {
        srv.close();
        die("Timeout, server 127.0.0.1 not responding.");
      }, lifetime);
    }
  });
}

// SIGTERM is how the app closes a forward; exit quietly so a test can tell a
// deliberate teardown from a crash.
process.on("SIGTERM", () => process.exit(0));
