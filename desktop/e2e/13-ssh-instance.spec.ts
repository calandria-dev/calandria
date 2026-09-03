/* Attaching the desktop shell through an SSH port forward.
 *
 * Phase 2 of docs/superpowers/specs/2026-09-02-remote-instances-design.md, and
 * the half desktop/test-supervisor.js cannot reach: there, `ssh` is
 * desktop/stub-ssh.js and the argv is checked against `sshArgs()`, which proves
 * the two agree with each other and nothing about whether OpenSSH accepts them.
 * Here the binary is the real one.
 *
 * SKIPPED WHERE THERE IS NO SSHD, deliberately and loudly. The probe is the
 * exact command the app runs — BatchMode and all — so a box where key auth is
 * not set up, or where localhost's host key is not yet known, skips instead of
 * failing: the app would refuse that host too, and telling the user to set up a
 * key is the RIGHT answer there rather than a red test. The transport's own
 * logic (spawn args, the port wait, backoff, teardown) is covered without an
 * sshd by the ssh-tunnel.js section of desktop/test-supervisor.js.
 *
 * What only this pass can say: a real `ssh -L` comes up with the arguments the
 * spec names, the window loads a LOOPBACK origin that is really the other
 * server, and quitting takes the ssh child with it.
 */

import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  attachShellLog,
  bootRemoteServer,
  ensureOnboarded,
  instanceRoot,
  launchShell,
  quitShell,
  writeInstancesFile,
  type RemoteServer,
  type Shell,
} from "./fixtures";

/** `localhost` unless a box has somewhere better to forward through. */
const SSH_HOST = process.env.CALANDRIA_E2E_SSH_HOST || "localhost";

/**
 * Can this box run the app's own ssh command without asking a human anything?
 *
 * Same options the tunnel uses, so the answer is about the thing under test
 * rather than about a friendlier command. `-o ConnectTimeout` is the one
 * addition, to keep a wedged probe from eating the suite's timeout.
 */
function sshIsUsable(): boolean {
  try {
    execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", SSH_HOST, "true"], {
      stdio: "ignore",
      timeout: 20_000,
    });
    return true;
  } catch {
    return false;
  }
}

const SSH_OK = sshIsUsable();

test.describe.configure({ mode: "serial" });
test.skip(
  !SSH_OK,
  `no key-based ssh to ${SSH_HOST} on this box — the transport is covered by desktop/test-supervisor.js instead`,
);

const NAME = "Build box";

let remote: RemoteServer;
let shell: Shell;
let quitted = false;

test.beforeAll(async () => {
  remote = await bootRemoteServer("ssh-server");
  await ensureOnboarded(remote.origin);

  // The "remote" is this machine reached the long way round: a second real
  // production server on its own port and its own hermetic instance, and an
  // `ssh localhost` forward standing between the window and it. Every part of
  // the path the app takes is real except the distance.
  const configRoot = instanceRoot("ssh-shell-config");
  const instancesFile = writeInstancesFile(configRoot, {
    active: "b2c4",
    instances: [
      { id: "local", kind: "local", name: "This computer" },
      {
        id: "b2c4",
        kind: "ssh",
        name: NAME,
        ssh: { host: SSH_HOST, remotePort: Number(new URL(remote.origin).port) },
      },
    ],
  });

  shell = await launchShell("ssh", {
    env: {
      CALANDRIA_INSTANCES_FILE: instancesFile,
      SERVICE_TOKEN: "local-only-token",
    },
  });
});

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  if (!quitted) await quitShell(shell);
  await remote?.stop();
});

test("the window attaches to a loopback origin that is really the other server", async () => {
  const url = new URL(shell.win.url());
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.origin).not.toBe(remote.origin);
  // The local port is the app's choice, not the remote one wearing a disguise.
  expect(Number(url.port)).not.toBe(Number(new URL(remote.origin).port));

  // The app rendered, on the other server's bundle.
  await expect(shell.win.locator("body")).toBeVisible();

  // And the forward really goes there: the project list read through it is the
  // remote instance's, seeded by this file's own onboarding call. A local
  // server answering on that port would have a different (empty) one — and
  // there is no local server, which the log below says separately.
  const through = await fetch(`${url.origin}/api/projects`).then((r) => r.json());
  const direct = await fetch(`${remote.origin}/api/projects`).then((r) => r.json());
  expect(through).toEqual(direct);
  expect(Array.isArray(through) ? through.length : 0).toBeGreaterThan(0);

  await expect
    .poll(() => shell.log.some((l) => l.includes(`[shell] ssh forward for ${NAME}`)), { timeout: 15_000 })
    .toBe(true);
  // An ssh instance must not start a server of its own, for the same reason a
  // url one must not: the whole point is that the server is elsewhere.
  expect(shell.log.some((l) => l.includes("[shell] ready on"))).toBe(false);
});

test("the forward is the command the spec names, run by the real ssh", async () => {
  // Read off the PROCESS TABLE rather than the shell's log. The argv is logged
  // before the window appears, which is before `electron.launch()` resolves and
  // therefore before `shell.log` starts — and the running child is the better
  // witness anyway: it is what OpenSSH accepted, not what the app said it would
  // pass. (`ps` spelt for POSIX; the file already skips a box with no key-based
  // ssh, which is every Windows runner this suite has.)
  test.skip(process.platform === "win32", "no ps(1) to read the child's argv from");
  const port = new URL(shell.win.url()).port;
  const remotePort = new URL(remote.origin).port;
  const forward = `-L 127.0.0.1:${port}:127.0.0.1:${remotePort}`;
  const table = execFileSync("ps", ["-eo", "args="], { encoding: "utf8" });
  const spawned = table.split("\n").find((l) => l.includes(forward) && l.includes("ssh"));
  expect(spawned, `no ssh child forwarding ${forward}`).toBeTruthy();
  expect(spawned).toContain("-N");
  expect(spawned).toContain("-o ExitOnForwardFailure=yes");
  // The option that makes an unanswerable prompt an error instead of a hang.
  expect(spawned).toContain("-o BatchMode=yes");
  expect(spawned?.trimEnd().endsWith(SSH_HOST)).toBe(true);
});

test("quitting takes the ssh child with it", async () => {
  const origin = new URL(shell.win.url()).origin;
  expect(await reachable(origin)).toBe(true);

  await quitShell(shell);
  quitted = true;

  // The forward is gone with the app. An orphaned `ssh -N` would hold this port
  // for the rest of the session, and the next launch would fail to bind it.
  await expect.poll(() => reachable(origin), { timeout: 20_000 }).toBe(false);
  // The server on the other side is untouched — it was never this app's to stop.
  expect(await reachable(remote.origin)).toBe(true);
});

async function reachable(origin: string): Promise<boolean> {
  return fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
}
