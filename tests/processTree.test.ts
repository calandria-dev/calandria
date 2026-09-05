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
  hasProcessGroups,
  killTree,
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

describe("processTree: win32 rules (mocked platform)", () => {
  it("has no process groups — so no detached spawn, and no SIGKILL escalation", () => {
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

  it("reads liveness out of tasklist's output, not its exit code", () => {
    // tasklist exits 0 either way; a miss prints an INFO line instead of a row.
    const hit = recorder('"cmd.exe","4242","Console","1","4,100 K"\r\n');
    expect(treeAlive(4242, { platform: "win32", exec: hit.exec })).toBe(true);
    expect(hit.calls).toEqual([
      { file: "tasklist", args: ["/fi", "PID eq 4242", "/nh", "/fo", "csv"] },
    ]);

    const miss = recorder("INFO: No tasks are running which match the specified criteria.\r\n");
    expect(treeAlive(4242, { platform: "win32", exec: miss.exec })).toBe(false);
  });

  it("guards against pid reuse with a command-line lookup", () => {
    const cmd = "npm run dev";
    const ours = recorder(`C:\\WINDOWS\\system32\\cmd.exe /d /s /c "${cmd}"\r\n`);
    expect(treeMatchesCommand(4242, cmd, { platform: "win32", exec: ours.exec })).toBe(true);
    expect(ours.calls).toEqual([
      {
        file: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance Win32_Process -Filter 'ProcessId = 4242').CommandLine",
        ],
      },
    ]);
    // No double quote reaches the argument: Node's win32 escaping and
    // PowerShell's re-parsing disagree about those.
    expect(ours.calls[0].args.join(" ")).not.toContain('"');

    // The pid was recycled by something else: same pid, different command line.
    const stranger = recorder("C:\\WINDOWS\\system32\\svchost.exe -k netsvcs\r\n");
    expect(treeMatchesCommand(4242, cmd, { platform: "win32", exec: stranger.exec })).toBe(false);
    // Dead pid: empty output, no match (and never a kill).
    expect(treeMatchesCommand(4242, cmd, { platform: "win32", exec: recorder("\r\n").exec })).toBe(false);
  });

  it("answers 'no' when it cannot find out — leaving an orphan beats killing a stranger", () => {
    const calls: { file: string; args: string[] }[] = [];
    expect(treeMatchesCommand(4242, "npm run dev", { platform: "win32", exec: thrower(calls) })).toBe(false);
    expect(treeAlive(4242, { platform: "win32", exec: thrower(calls) })).toBe(false);
    expect(treeMatchesCommand(4242, "   ", { platform: "win32", exec: recorder("anything").exec })).toBe(false);
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

  onPosix("SIGTERM is a real signal here — the tree gets a chance to exit cleanly", async () => {
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
