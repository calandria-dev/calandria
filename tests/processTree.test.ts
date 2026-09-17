/* Killing a spawned command's whole tree, on both process models.
 *
 * Two halves, and only one of them can be run for real from this suite:
 *
 *   - POSIX is exercised against actual processes: a `sh -c` wrapper with a
 *     real grandchild under it, which is the shape every managed service has
 *     (lib/services.ts spawns with shell:true). What's pinned is that the
 *     GRANDCHILD dies too, since killing the pid we hold would leave the dev
 *     server holding the port.
 *   - win32 has no process groups and no `ps`, so its branches are driven
 *     through the injected `exec` hook with `platform: "win32"`. The argv
 *     handed to taskkill/tasklist/PowerShell is the contract, and it's the
 *     part a Windows CI lane will later confirm end to end.
 *
 * See docs/WINDOWS.md §2.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  confirmTreeCommand,
  hasProcessGroups,
  killTree,
  killTreeAndWait,
  probeTreeCommand,
  treeAlive,
  treeMatchesCommand,
} from "@/lib/processTree";
import { outputLines } from "./platform";

const posix = process.platform !== "win32";
const onPosix = posix ? it : it.skip;

// ---------- win32, through the injected runner ----------

/** Records every command the module shells out to, and replays canned stdout. */
function recorder(stdout: string | ((file: string, args: string[]) => string) = "") {
  const calls: { file: string; args: string[] }[] = [];
  return {
    calls,
    exec: (file: string, args: string[]) => {
      calls.push({ file, args });
      const out = typeof stdout === "function" ? stdout(file, args) : stdout;
      return out;
    },
  };
}

const thrower = (calls: { file: string; args: string[] }[]) => (file: string, args: string[]) => {
  calls.push({ file, args });
  throw new Error("not found");
};

// `probeTreeCommand` short-circuits on liveness before it shells out, and
// liveness is now a real signal-0 check even under `platform: "win32"`. So a
// case that wants the command lookup to run has to name a pid that really is
// alive; an invented one would be a coin flip on whether the host happens to
// have it. This process qualifies, and outlives the suite.
const LIVE = process.pid;

describe("processTree: win32 rules (mocked platform)", () => {
  it("has no process groups, so no detached spawn and no SIGKILL escalation", () => {
    expect(hasProcessGroups("win32")).toBe(false);
    expect(hasProcessGroups("linux")).toBe(true);
    expect(hasProcessGroups("darwin")).toBe(true);
  });

  it("kills the tree with a single forced taskkill, whatever signal was asked for", () => {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const r = recorder();
      expect(killTree(4242, signal, { platform: "win32", exec: r.exec })).toBe(true);
      expect(r.calls).toEqual([{ file: "taskkill", args: ["/pid", "4242", "/T", "/F"] }]);
    }
  });

  it("reports a failed taskkill so the caller can fall back to the direct child", () => {
    const calls: { file: string; args: string[] }[] = [];
    expect(killTree(4242, "SIGTERM", { platform: "win32", exec: thrower(calls) })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("refuses a pid that isn't one, without shelling out", () => {
    for (const pid of [0, -1, Number.NaN, 1.5]) {
      const r = recorder();
      expect(killTree(pid, "SIGKILL", { platform: "win32", exec: r.exec })).toBe(false);
      expect(treeAlive(pid, { platform: "win32", exec: r.exec })).toBe(false);
      expect(treeMatchesCommand(pid, "npm run dev", { platform: "win32", exec: r.exec })).toBe(false);
      expect(r.calls).toEqual([]);
    }
  });

  // Liveness is signal 0 on both platforms, so this branch runs for real from
  // here: with `platform: "win32"` the only difference is that the pid is NOT
  // negated, which is what a host without process groups needs. Measured on a
  // real Windows desktop at 0ms against `tasklist`'s 9.5-10.5s, which is why
  // a bounded wait can poll it at all.
  onPosix("asks about the pid itself, with no subprocess and no negation", async () => {
    const { pid } = spawnService();
    await settle();
    const r = recorder();
    expect(treeAlive(pid, { platform: "win32", exec: r.exec })).toBe(true);
    expect(r.calls).toEqual([]); // nothing was shelled out to

    killTree(pid, "SIGKILL");
    await settle();
    expect(treeAlive(pid, { platform: "win32", exec: r.exec })).toBe(false);
    // A pid that never existed is not alive, and neither is a non-pid.
    expect(treeAlive(0x7fffffff, { platform: "win32" })).toBe(false);
  });

  it("guards against pid reuse with a command-line lookup", () => {
    const cmd = "npm run dev";
    const ours = recorder(`CALANDRIA_CMDLINE:C:\\WINDOWS\\system32\\cmd.exe /d /s /c "${cmd}"\r\n`);
    expect(treeMatchesCommand(LIVE, cmd, { platform: "win32", exec: ours.exec })).toBe(true);
    expect(ours.calls).toHaveLength(1);
    expect(ours.calls[0].file).toBe("powershell.exe");
    expect(ours.calls[0].args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    // The pid is interpolated into the filter, and every marker the reply is
    // parsed for is asked for by name.
    expect(ours.calls[0].args[3]).toContain(`ProcessId = ${LIVE}`);
    for (const marker of ["CALANDRIA_CMDLINE:", "CALANDRIA_NOPROC", "CALANDRIA_PROBEFAIL"]) {
      expect(ours.calls[0].args[3]).toContain(marker);
    }
    // No double quote reaches the argument: Node's win32 escaping and
    // PowerShell's re-parsing disagree about those.
    expect(ours.calls[0].args.join(" ")).not.toContain('"');

    // The pid was recycled by something else: same pid, different command line.
    const stranger = recorder("CALANDRIA_CMDLINE:C:\\WINDOWS\\system32\\svchost.exe -k netsvcs\r\n");
    expect(probeTreeCommand(LIVE, cmd, { platform: "win32", exec: stranger.exec })).toBe("mismatch");
    // Dead pid: a definite no, and never a kill.
    expect(probeTreeCommand(LIVE, cmd, { platform: "win32", exec: recorder("CALANDRIA_NOPROC\r\n").exec }))
      .toBe("mismatch");
  });

  // Issue #324: on a loaded Windows runner the CommandLine lookup came back
  // empty, which the old boolean probe could only report as "not ours". The
  // reap declined and a live orphan kept the port, 13 seconds after the kill
  // that was never issued.
  it("separates 'could not find out' from 'not ours', so a stumbling probe is not an answer", () => {
    const cmd = "npm run dev";
    const win = { platform: "win32" as const };
    // PowerShell ran but the CIM query threw.
    expect(probeTreeCommand(LIVE, cmd, { ...win, exec: recorder("CALANDRIA_PROBEFAIL\r\n").exec }))
      .toBe("unknown");
    // PowerShell produced nothing at all, or died on the exec timeout.
    expect(probeTreeCommand(LIVE, cmd, { ...win, exec: recorder("").exec })).toBe("unknown");
    expect(probeTreeCommand(LIVE, cmd, { ...win, exec: thrower([]) })).toBe("unknown");
    // The process exists but would not show its command line.
    expect(probeTreeCommand(LIVE, cmd, { ...win, exec: recorder("CALANDRIA_CMDLINE:\r\n").exec }))
      .toBe("unknown");
    // A reply wrapped by PowerShell's formatter is still the command line.
    const wrapped = recorder(`CALANDRIA_CMDLINE:cmd.exe /d /s /c "npm run\r\n dev"\r\n`);
    expect(probeTreeCommand(LIVE, cmd, { ...win, exec: wrapped.exec })).toBe("match");
  });

  it("retries an unanswered probe and settles on the first definite answer", async () => {
    const cmd = "npm run dev";
    const win = { platform: "win32" as const };
    const fast = { ...win, retryDelayMs: 0 };

    // Two stumbles, then the truth: the orphan is reaped rather than abandoned.
    let n = 0;
    const flaky = recorder(() => (++n < 3 ? "" : `CALANDRIA_CMDLINE:cmd.exe /d /s /c "${cmd}"`));
    expect(await confirmTreeCommand(LIVE, cmd, { ...fast, exec: flaky.exec })).toBe("match");
    expect(flaky.calls).toHaveLength(3);

    // A recycled pid does not become ours by asking again.
    const stranger = recorder("CALANDRIA_CMDLINE:svchost.exe -k netsvcs");
    expect(await confirmTreeCommand(LIVE, cmd, { ...fast, exec: stranger.exec })).toBe("mismatch");
    expect(stranger.calls).toHaveLength(1);

    // An exhausted budget still refuses to kill: the bias is unchanged.
    // A spent budget stops the retries: three attempts at the slow exec
    // timeout would hold boot restore for a minute and a half.
    const slow = recorder("");
    expect(await confirmTreeCommand(LIVE, cmd, { ...win, exec: slow.exec, budgetMs: 0 })).toBe("unknown");
    expect(slow.calls).toHaveLength(1);

    const mute = recorder("");
    expect(await confirmTreeCommand(LIVE, cmd, { ...fast, exec: mute.exec })).toBe("unknown");
    expect(treeMatchesCommand(LIVE, cmd, { ...win, exec: mute.exec })).toBe(false);
    expect(mute.calls).toHaveLength(4); // 3 attempts, plus the boolean check
  });

  // The win32 kill is `taskkill /T /F`, which returns once it has asked. Only
  // the liveness poll can say the tree is actually gone, and a caller about to
  // respawn onto the same port needs that stronger claim.
  onPosix("waits for the tree to be gone, not for taskkill to return", async () => {
    // A mocked taskkill that reports success and kills nothing: the wait must
    // not take its word for it.
    const { pid } = spawnService();
    await settle();
    const liar = recorder("SUCCESS: sent termination signal");
    expect(
      await killTreeAndWait(pid, "SIGKILL", {
        platform: "win32",
        exec: liar.exec,
        timeoutMs: 300,
        intervalMs: 10,
      })
    ).toBe(false);
    expect(liar.calls[0].file).toBe("taskkill");
    expect(treeAlive(pid)).toBe(true); // still there, and reported as such

    // A taskkill that really does kill: the wait observes it and says so.
    const real = recorder(() => {
      process.kill(-pid, "SIGKILL");
      return "SUCCESS";
    });
    expect(
      await killTreeAndWait(pid, "SIGKILL", {
        platform: "win32",
        exec: real.exec,
        timeoutMs: 5000,
        intervalMs: 10,
      })
    ).toBe(true);

    // Nothing to kill is nothing to wait for.
    expect(await killTreeAndWait(0, "SIGKILL", { platform: "win32", exec: liar.exec })).toBe(true);
  });

  it("answers 'no' when it cannot find out, since leaving an orphan beats killing a stranger", () => {
    const calls: { file: string; args: string[] }[] = [];
    expect(treeMatchesCommand(LIVE, "npm run dev", { platform: "win32", exec: thrower(calls) })).toBe(false);
    expect(treeMatchesCommand(LIVE, "   ", { platform: "win32", exec: recorder("anything").exec })).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});

// ---------- POSIX, against real processes ----------

const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const p of spawned.splice(0)) {
    if (p.pid != null) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } }
  }
});

/** A managed service in miniature: `sh -c` on top, a long-lived node under it. */
function spawnService(): { proc: ChildProcess; pid: number; command: string } {
  const command = `node -e "setTimeout(()=>{},30000)"`;
  const proc = spawn(command, { shell: true, detached: true, stdio: "ignore" });
  spawned.push(proc);
  return { proc, pid: proc.pid!, command };
}

/** Every live pid in `pid`'s process group, per `ps`. */
function groupMembers(pid: number): string[] {
  const out = execFileSync("ps", ["-A", "-o", "pgid=,pid=,command="], { encoding: "utf8" });
  return outputLines(out)
    .map((l) => l.trim())
    .filter((l) => Number(l.slice(0, l.indexOf(" "))) === pid);
}

async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("processTree: POSIX", () => {
  onPosix("kills the grandchild too, not just the shell we hold", async () => {
    const { pid } = spawnService();
    await settle();
    // The tree really is a tree: the `sh -c` wrapper plus the node under it.
    expect(groupMembers(pid).length).toBeGreaterThan(1);
    expect(treeAlive(pid)).toBe(true);

    expect(killTree(pid, "SIGKILL")).toBe(true);
    await settle();
    expect(groupMembers(pid)).toEqual([]);
    expect(treeAlive(pid)).toBe(false);
  });

  onPosix("SIGTERM is a real signal here, so the tree gets a chance to exit cleanly", async () => {
    const { proc, pid } = spawnService();
    await settle();
    const exited = new Promise<void>((r) => proc.once("exit", () => r()));
    expect(killTree(pid, "SIGTERM")).toBe(true);
    await exited;
    await settle(100);
    expect(treeAlive(pid)).toBe(false);
  });

  onPosix("a dead tree reports false rather than throwing", async () => {
    const { pid } = spawnService();
    killTree(pid, "SIGKILL");
    await settle();
    expect(killTree(pid, "SIGKILL")).toBe(false);
    expect(treeAlive(pid)).toBe(false);
    expect(treeMatchesCommand(pid, `node -e "setTimeout(()=>{},30000)"`)).toBe(false);
  });

  onPosix("matches a live tree by its command line, and only that command", async () => {
    const { pid, command } = spawnService();
    await settle();
    expect(treeMatchesCommand(pid, command)).toBe(true);
    expect(treeMatchesCommand(pid, "some other service")).toBe(false);
    expect(treeMatchesCommand(pid, "  ")).toBe(false);
    killTree(pid, "SIGKILL");
  });
});
