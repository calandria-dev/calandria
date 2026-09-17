// How the throwaway `codex app-server` child is stopped, per platform.
//
// Both branches are pinned here because each one fails in a way the other
// platform cannot show. lib/processTree.ts takes an injectable platform and
// exec for exactly this, so the win32 rules run on POSIX.

import { describe, it, expect, vi } from "vitest";
import { teardownChild } from "@/lib/agents/codex/appServer";

function fakeChild(pid = 4321) {
  return { pid, kill: vi.fn(() => true) };
}

describe("codex app-server one-shot teardown", () => {
  it("kills the whole tree on win32, while the direct child is still alive", () => {
    // The direct child there is cmd.exe wrapping codex's `.cmd` shim. Killing
    // only cmd.exe leaves the CLI running with the call's cwd as its working
    // directory, and Windows refuses to remove a directory that is any
    // process's cwd, so a caller that passed a temp cwd could never delete it.
    const child = fakeChild();
    const exec = vi.fn(() => "");
    teardownChild(child, { platform: "win32", exec });
    expect(exec).toHaveBeenCalledWith("taskkill", ["/pid", "4321", "/T", "/F"]);
    // taskkill walks the parent chain, so the direct kill has to come after it.
    expect(exec.mock.invocationCallOrder[0]).toBeLessThan(child.kill.mock.invocationCallOrder[0]);
  });

  it("never issues a group kill on POSIX", () => {
    // This spawn does not ask for its own process group, so the negative-pid
    // kill inside killTree would signal the whole calling process, the test
    // runner included. The direct child is the CLI itself, so killing it is
    // already enough.
    const child = fakeChild();
    const exec = vi.fn(() => "");
    const groupKill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      teardownChild(child, { platform: "linux", exec });
      expect(groupKill).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      groupKill.mockRestore();
    }
  });

  it("survives a child that has already exited", () => {
    const child = {
      pid: 4321,
      kill: vi.fn(() => {
        throw new Error("ESRCH");
      }),
    };
    expect(() => teardownChild(child, { platform: "linux" })).not.toThrow();
  });

  it("does not hand a kill command a pid it cannot use", () => {
    const exec = vi.fn(() => "");
    teardownChild({ pid: undefined, kill: vi.fn(() => true) }, { platform: "win32", exec });
    expect(exec).not.toHaveBeenCalled();
  });
});
