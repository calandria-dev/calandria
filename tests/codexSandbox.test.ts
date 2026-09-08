import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  sandboxWarningReason,
  firstSandboxWarning,
  noteCodexSandboxWarning,
  noteCodexSandboxHealthy,
  sandboxRefusal,
  usesExternalSandbox,
  CODEX_AGENT,
} from "@/lib/agents/codex/sandbox";
import { getAgentSandboxBroken, clearAgentSandboxBroken, markAgentSandboxBroken, getAgentAuthBroken } from "@/lib/agents/connections";
import { codexRunPolicy, sandboxPolicyObject } from "@/lib/agents/codex/policy";

// The exact strings codex-cli 0.153.0 ships, read out of the binary. The point
// of pinning them verbatim is that the classifier is the ONLY thing standing
// between a host that can't create user namespaces and a turn that spends money
// failing every command it runs.
const USERNS = "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.";
const WSL1 =
  "Codex's Linux sandbox uses bubblewrap, which is not supported on WSL1 because WSL1 cannot create " +
  "the required user namespaces. Use WSL2 for sandboxed shell commands.";
const MISSING_BWRAP =
  "Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. " +
  "See the sandbox prerequisites. Codex will use the bundled bubblewrap in the meantime.";

beforeEach(() => {
  clearAgentSandboxBroken(CODEX_AGENT);
});
afterEach(() => {
  clearAgentSandboxBroken(CODEX_AGENT);
});

describe("codex sandbox warning classifier", () => {
  it("flags the warning this host actually produces", () => {
    expect(sandboxWarningReason(USERNS)).toBe(USERNS);
  });

  it("flags the WSL1 variant, which fails the same way", () => {
    expect(sandboxWarningReason(WSL1)).toBe(WSL1);
  });

  it("does NOT flag the missing-bwrap warning, which names its own fallback", () => {
    // The CLI says in the same breath that it will use the bundled bubblewrap,
    // so treating this as broken would refuse turns that work.
    expect(sandboxWarningReason(MISSING_BWRAP)).toBeNull();
  });

  it("ignores warnings that have nothing to do with the sandbox", () => {
    expect(sandboxWarningReason("Unknown key `foo` in config.toml")).toBeNull();
    expect(sandboxWarningReason("")).toBeNull();
    expect(sandboxWarningReason("   ")).toBeNull();
  });

  it("needs both a sandbox subject and a namespace failure", () => {
    expect(sandboxWarningReason("your kubernetes user namespaces are misconfigured")).toBeNull();
    expect(sandboxWarningReason("the sandbox could not open a socket")).toBeNull();
  });

  it("picks the first real one out of a batch", () => {
    expect(firstSandboxWarning([MISSING_BWRAP, "unrelated", USERNS])).toBe(USERNS);
    expect(firstSandboxWarning([MISSING_BWRAP, "unrelated"])).toBeNull();
    expect(firstSandboxWarning([])).toBeNull();
  });
});

describe("the recorded flag", () => {
  it("records the CLI's own words and reports whether it was the first sighting", () => {
    expect(noteCodexSandboxWarning(USERNS)).toBe(true);
    expect(getAgentSandboxBroken(CODEX_AGENT)?.reason).toBe(USERNS);
  });

  it("keeps the first timestamp across repeats, so the card can age it", () => {
    markAgentSandboxBroken(CODEX_AGENT, USERNS, 1000);
    markAgentSandboxBroken(CODEX_AGENT, USERNS, 9000);
    expect(getAgentSandboxBroken(CODEX_AGENT)?.at).toBe(1000);
  });

  it("does not record a benign warning", () => {
    expect(noteCodexSandboxWarning(MISSING_BWRAP)).toBe(false);
    expect(getAgentSandboxBroken(CODEX_AGENT)).toBeNull();
  });

  it("is cleared by a turn that saw no sandbox warning", () => {
    noteCodexSandboxWarning(USERNS);
    noteCodexSandboxHealthy();
    expect(getAgentSandboxBroken(CODEX_AGENT)).toBeNull();
  });

  it("is NOT the dead-login flag", () => {
    // Separate keys on purpose: reconnecting fixes a login and does nothing for
    // a sandbox, and the titlebar's "sign in again" would be the wrong advice.
    noteCodexSandboxWarning(USERNS);
    expect(getAgentAuthBroken(CODEX_AGENT)).toBeNull();
  });
});

describe("refusing a turn that cannot work", () => {
  const modeSandbox = (mode: string) => codexRunPolicy(mode, process.cwd()).sandbox;

  it("lets every mode run while the flag is clear", () => {
    for (const mode of ["auto", "default", "acceptEdits", "bypassPermissions", "plan"]) {
      expect(sandboxRefusal(modeSandbox(mode))).toBeNull();
    }
  });

  it("refuses the sandboxed modes once the flag is set, naming the fix", () => {
    noteCodexSandboxWarning(USERNS);
    for (const mode of ["auto", "default", "acceptEdits"]) {
      const msg = sandboxRefusal(modeSandbox(mode));
      expect(msg).toContain("workspace-write");
      expect(msg).toContain(USERNS);
      expect(msg).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
      expect(msg).toContain("bypassPermissions");
    }
    expect(sandboxRefusal(modeSandbox("plan"))).toContain("read-only");
  });

  it("never refuses bypassPermissions, which uses no sandbox at all", () => {
    noteCodexSandboxWarning(USERNS);
    expect(sandboxRefusal(modeSandbox("bypassPermissions"))).toBeNull();
  });
});

describe("CODEX_EXTERNAL_SANDBOX", () => {
  // The knob is read at import time (lib/config.ts), so the mapping is driven
  // directly rather than by setting env the module already read.
  it("sends externalSandbox for workspace-write and nothing else", () => {
    const write = codexRunPolicy("acceptEdits", process.cwd());
    expect(sandboxPolicyObject(write, true)).toEqual({ type: "externalSandbox" });
    expect(sandboxPolicyObject(write, false).type).toBe("workspaceWrite");

    // read-only is left alone even when asked: a container is not a read-only
    // filesystem, and plan mode's whole guarantee is that nothing is writable.
    const plan = codexRunPolicy("plan", process.cwd());
    expect(sandboxPolicyObject(plan, true)).toEqual({ type: "readOnly", networkAccess: false });

    const full = codexRunPolicy("bypassPermissions", process.cwd());
    expect(sandboxPolicyObject(full, true)).toEqual({ type: "dangerFullAccess" });
  });

  it("is off by default, so nothing runs unconfined without being asked", () => {
    expect(usesExternalSandbox("workspace-write")).toBe(false);
    expect(usesExternalSandbox("read-only")).toBe(false);
  });
});
