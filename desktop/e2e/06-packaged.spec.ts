/* Pins the packaged build, not the checkout: with `CALANDRIA_TEST_BIN` set,
 * the app must boot its server out of `resources/app-payload` with no
 * `CALANDRIA_REPO_ROOT` set, spawn the Node it shipped instead of whatever is
 * on PATH, and package its sandbox helper the way the OS needs it.
 *
 * `fixtures.ts` drops `CALANDRIA_REPO_ROOT` for a packaged run and refuses an
 * artifact still standing inside this checkout, so the assertions below can
 * tell a real payload boot from one still leaning on the repo.
 *
 * Skipped whole when `CALANDRIA_TEST_BIN` is unset: the dev shell has no
 * payload, and `app.isPackaged` is false by construction.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { PACKAGED, attachShellLog, launchShell, quitShell, type Shell } from "./fixtures";

test.describe.configure({ mode: "serial" });

test.skip(!PACKAGED, "packaged-only: set CALANDRIA_TEST_BIN to the installed/unpacked executable");

/** Set by the lane that tests an install with its SUID sandbox intact. */
const SANDBOXED = process.env.CALANDRIA_DESKTOP_SANDBOX === "1";

type MainFacts = {
  packaged: boolean;
  repoRootEnv: string | null;
  resourcesPath: string;
  execPath: string;
  noSandboxSwitch: boolean;
};

let shell: Shell;
let facts: MainFacts;

/**
 * Everything the supervisor narrated, earliest line included.
 *
 * `shell.log` alone is not enough: stdout capture only starts once
 * `electron.launch()` has resolved (fixtures.ts, `Shell.log`), by which
 * point the two lines this file cares about, the payload root and the
 * resolved Node, are the supervisor's first output and already flushed. The
 * boot screen keeps them: main.js pushes every line into `<pre id="log">`
 * until the window swaps to the app, and the fixture reads that back before
 * it goes.
 */
function bootLines(): string[] {
  return `${shell.bootScreenLog}\n${shell.log.join("\n")}`.split(/\r?\n/).map((l) => l.trim());
}

test.beforeAll(async () => {
  shell = await launchShell("packaged");
  facts = await shell.app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    // Read inside the main process rather than trusting the object this suite
    // built: what matters is what the shell was actually handed.
    repoRootEnv: process.env.CALANDRIA_REPO_ROOT ?? null,
    // `resourcesPath` is Electron's addition to `process` and this file is
    // compiled against Node's types, hence the cast.
    resourcesPath: (process as unknown as { resourcesPath: string }).resourcesPath,
    execPath: process.execPath,
    noSandboxSwitch: app.commandLine.hasSwitch("no-sandbox"),
  }));
});

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  await quitShell(shell);
});

test("the app booted from its own payload, with no CALANDRIA_REPO_ROOT and no checkout in reach", async () => {
  expect(facts.packaged, "electron says this is not a packaged app — CALANDRIA_TEST_BIN is pointing at a dev build").toBe(
    true
  );
  // The absence is the subject: with this set, nothing below would be evidence
  // of anything (see the file header).
  expect(facts.repoRootEnv).toBeNull();

  // main.js's fallback for a packaged app. Asserted through the supervisor's
  // own log line rather than by recomputing the path here, so what is checked
  // is the value the sidecars were really spawned against.
  //
  // Read off the boot screen, not `shell.log`: this is the supervisor's
  // first line, and stdout capture only starts once `electron.launch()` has
  // resolved (fixtures.ts, `Shell.log`), by which time it is long flushed.
  // The boot screen keeps it, since main.js pushes every line into
  // `<pre id="log">` before the swap, so the earliest lines are legible
  // there. Both are searched anyway, since a slower boot puts the line in
  // each.
  const payload = path.join(facts.resourcesPath, "app-payload");
  expect(bootLines().join("\n")).toContain(`[shell] payload: ${payload}`);

  // The payload carries the server, its build and its production
  // dependencies. If any of the three were missing, the boot the fixture
  // already waited for could not have happened, but naming them makes a
  // half-copied artifact fail with the file it lost rather than with a Next
  // stack trace.
  for (const entry of ["server.js", "pty-server.js", ".next", path.join("node_modules", "next")]) {
    expect(fs.existsSync(path.join(payload, entry)), `${entry} missing from the packaged payload`).toBe(true);
  }

  // And the shell really served the app out of it.
  const version = await fetch(`${shell.origin}/api/version`).then((r) => r.json());
  expect(version.version).toBeTruthy();
  await expect(shell.win.locator("body")).not.toBeEmpty();
});

test("the sidecars run under the bundled Node, not whatever is on PATH", async () => {
  // `resolveNode()` prefers `<resourcesPath>/node/bin/node` and labels its
  // choice. A packaged app that fell through to the PATH would still boot on
  // a developer's machine and fail on a user's, or worse, load a
  // better-sqlite3 prebuild compiled for a different NODE_MODULE_VERSION and
  // die at the first query.
  const line = bootLines().find((l) => l.startsWith("[shell] node: "));
  expect(line, "the supervisor never reported which node it resolved").toBeTruthy();
  expect(line).toContain("(bundled)");
  expect(line).toContain(path.join(facts.resourcesPath, "node"));
});

test("the OS sandbox is live here, or this lane is the one that admits it isn't", async () => {
  test.skip(process.platform !== "linux", "the mechanisms below are Linux's");

  // The artifact ships the helper either way: electron-builder puts it
  // beside the executable in `--dir` output and in the .deb alike.
  const helper = path.join(path.dirname(facts.execPath), "chrome-sandbox");
  expect(fs.existsSync(helper), "the artifact has no chrome-sandbox helper beside its executable").toBe(true);
  const st = fs.statSync(helper);
  const suidRoot = st.uid === 0 && (st.mode & 0o4000) !== 0;

  // Whether the sandbox is really on is a fact about running processes, not
  // about a mode bit, because the mode bit no longer answers it.
  // electron-builder 26's postinst chmods chrome-sandbox to 0755 when
  // unprivileged user namespaces work and installs an AppArmor profile
  // (/etc/apparmor.d/calandria-desktop) instead, which is what lets the app
  // keep its namespace sandbox under Ubuntu 24.04's
  // kernel.apparmor_restrict_unprivileged_userns=1. So a .deb install with no
  // SUID bit anywhere is sandboxed, and asserting the bit would fail a
  // correctly-installed app.
  //
  // What both mechanisms produce, and --no-sandbox cannot, is a descendant
  // process running in its own user namespace, distinct from the main
  // process's.
  const isolated = descendants(shell.proc.pid!).filter((p) => p.userNs && p.userNs !== mainUserNs());

  if (SANDBOXED) {
    // The packaged-install lane: this assertion needs a package that was
    // actually installed, which is why the bench lane exists next to the
    // Ubuntu one.
    expect(facts.noSandboxSwitch, "the suite passed --no-sandbox in the lane whose whole point is not to").toBe(false);
    expect(
      isolated.map((p) => p.cmd),
      `no descendant of the shell is in its own user namespace, so the sandbox is not running: ` +
        `chrome-sandbox suid=${suidRoot}, and an AppArmor profile for this app may be missing`
    ).not.toHaveLength(0);
  } else {
    // CI's `electron-builder --dir` output: nothing installed the SUID bit
    // and nothing installed a profile, so the suite passes --no-sandbox and
    // every process shares one namespace. Asserted rather than tolerated,
    // since this is what makes this lane's green conditional on a flag no
    // user ever sets.
    expect(suidRoot, "the unpacked artifact has a SUID chrome-sandbox: set CALANDRIA_DESKTOP_SANDBOX=1").toBe(false);
    expect(facts.noSandboxSwitch).toBe(true);
    expect(isolated, "this artifact IS sandboxed — it should be run without --no-sandbox").toHaveLength(0);
  }
});

/** The Electron main process's own user namespace, as `/proc` spells it. */
function mainUserNs(): string {
  return userNsOf(shell.proc.pid!) ?? "";
}

function userNsOf(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/ns/user`);
  } catch {
    // A process that exited between listing and reading, or one this test is
    // not permitted to inspect. Either way it is not evidence of a sandbox.
    return null;
  }
}

/**
 * Every process below `pid`, with its command line and user namespace.
 *
 * `pgrep -P` per level rather than one walk of /proc: the tree is a handful of
 * processes (zygotes, gpu, network, one renderer per window) and the recursion
 * is bounded by the depth Chromium actually uses.
 */
function descendants(pid: number): Array<{ pid: number; cmd: string; userNs: string | null }> {
  const out: Array<{ pid: number; cmd: string; userNs: string | null }> = [];
  const walk = (parent: number, depth: number) => {
    if (depth > 4) return;
    const res = spawnSync("pgrep", ["-P", String(parent)], { encoding: "utf8" });
    for (const line of res.stdout.split("\n")) {
      const child = Number(line.trim());
      if (!child) continue;
      let cmd = "";
      try {
        cmd = fs.readFileSync(`/proc/${child}/cmdline`, "utf8").replace(/\0/g, " ").trim().slice(0, 120);
      } catch {
        continue;
      }
      out.push({ pid: child, cmd, userNs: userNsOf(child) });
      walk(child, depth + 1);
    }
  };
  walk(pid, 0);
  return out;
}
