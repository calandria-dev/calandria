import { describe, expect, it, beforeEach } from "vitest";

// Connected-first agent resolution: the utility agent for internal one-shots
// (lib/agents/oneshots.ts), the connection record with its legacy-Claude
// fallback (lib/agents/connections.ts), the client's new-task default
// (app/shell/agents.ts), and the onboarding completion adoption that
// makes a Codex-only first run work end to end (lib/onboarding.ts).

import { setSetting, getSetting, createProject, createTask, getTask, updateTask } from "../lib/store";
import { getDb } from "../lib/db";
import { setAgentConnection, isAgentConnected, firstConnectedAgent, resolveConnectedAgent } from "../lib/agents/connections";
import { utilityDriver, resolveUtilityAgent } from "../lib/agents/oneshots";
import { completeOnboarding } from "../lib/onboarding";
import { createSuggestedTask } from "../lib/agentTools";
import { agentPickerNeeded, defaultAgentFor, pickerAgents } from "../app/shell/agents";
import type { AgentsBundle } from "../app/shell/types";

// Settings persist across tests (one shared DB per suite run) — reset every key
// the resolvers read so each test states its own world.
function resetSettings() {
  for (const key of [
    "utility_agent",
    "default_agent",
    "agent_conn_claude",
    "agent_conn_codex",
    "agent_conn_gemini",
    "onboarding_method",
    "onboarding_account",
    "onboarding_complete",
  ]) {
    setSetting(key, null);
  }
}

const connect = (id: string) => setAgentConnection(id, { method: "subscription", email: null, plan: null });

describe("connection record", () => {
  beforeEach(resetSettings);

  it("treats a pre-seam onboarding record as a live Claude connection", () => {
    expect(isAgentConnected("claude")).toBe(false);
    setSetting("onboarding_method", "subscription");
    setSetting("onboarding_account", "a@b.c|Max");
    expect(isAgentConnected("claude")).toBe(true);
    // The legacy fallback is Claude-only — other agents need a real record.
    expect(isAgentConnected("codex")).toBe(false);
  });

  it("resolves the first connected agent from an ordered preference list", () => {
    connect("codex");
    // Preferred but unconnected (claude) is skipped; unknown ids are skipped.
    expect(resolveConnectedAgent(["claude", "codex"])).toBe("codex");
    expect(resolveConnectedAgent(["not-an-agent"])).toBe("codex");
    expect(firstConnectedAgent()).toBe("codex");
  });
});

describe("utilityDriver (connected-first)", () => {
  beforeEach(resetSettings);

  it("throws an actionable error when no agent is connected", () => {
    expect(() => utilityDriver()).toThrow(/No coding agent is connected/);
  });

  it("falls to the only connected agent on a Codex-only instance", () => {
    connect("codex");
    expect(utilityDriver().id).toBe("codex");
  });

  // Same rule, third driver, no new code: the resolvers enumerate the registry
  // rather than a pair of ids, so an Antigravity-only instance gets its recaps
  // and /clear summaries from Antigravity.
  it("falls to the only connected agent on an Antigravity-only instance", () => {
    connect("gemini");
    expect(utilityDriver().id).toBe("gemini");
    expect(resolveConnectedAgent(["claude", "codex"])).toBe("gemini");
    expect(resolveUtilityAgent()).toEqual({ id: "gemini", configured: "claude", fallback: true });
  });

  it("prefers the built-in default when it is connected", () => {
    connect("claude");
    connect("codex");
    expect(utilityDriver().id).toBe("claude");
  });

  it("honors an explicit utility_agent that is connected", () => {
    connect("claude");
    connect("codex");
    setSetting("utility_agent", "codex");
    expect(utilityDriver().id).toBe("codex");
  });

  it("ignores an explicit utility_agent that is NOT connected", () => {
    connect("claude");
    setSetting("utility_agent", "codex");
    expect(utilityDriver().id).toBe("claude");
  });

  it("surfaces the no-agent error as a rejection from the async one-shots", async () => {
    const { summarizeProjectRecap } = await import("../lib/agents/oneshots");
    const project = createProject({ name: "NoAgents" });
    await expect(summarizeProjectRecap(project, "digest")).rejects.toThrow(/No coding agent is connected/);
  });
});

// What Settings renders as the EFFECTIVE utility agent. Same resolution as
// utilityDriver(), but reported rather than thrown — the "(fallback)" hint and
// the "nothing connected" note are both driven from here.
describe("resolveUtilityAgent (reported effective agent)", () => {
  beforeEach(resetSettings);

  it("reports no agent, and the configured default, when nothing is connected", () => {
    expect(resolveUtilityAgent()).toEqual({ id: null, configured: "claude", fallback: false });
  });

  it("is not a fallback when the configured agent is connected", () => {
    connect("claude");
    expect(resolveUtilityAgent()).toEqual({ id: "claude", configured: "claude", fallback: false });
  });

  it("flags a fallback when the configured agent is NOT connected", () => {
    connect("codex");
    setSetting("utility_agent", "claude");
    expect(resolveUtilityAgent()).toEqual({ id: "codex", configured: "claude", fallback: true });
  });

  it("treats the app default agent as configured when utility_agent is unset", () => {
    connect("codex");
    setSetting("default_agent", "codex");
    expect(resolveUtilityAgent()).toEqual({ id: "codex", configured: "codex", fallback: false });
  });

  it("prefers an explicit utility_agent over the app default when both are connected", () => {
    connect("claude");
    connect("codex");
    setSetting("default_agent", "claude");
    setSetting("utility_agent", "codex");
    expect(resolveUtilityAgent()).toEqual({ id: "codex", configured: "codex", fallback: false });
  });
});

describe("defaultAgentFor (client, connected-first)", () => {
  const bundle = (authed: Record<string, boolean>, def = "claude"): AgentsBundle => ({
    default: def,
    agents: Object.entries(authed).map(([id, authenticated]) => ({
      id,
      label: id,
      capabilities: {
        models: [],
        reasoningOptions: [],
        permissionModes: [],
        supportsAsks: true,
        supportsMcpTools: true,
        reportsCostUsd: true,
        costIsEstimated: false,
        supportsResume: true,
      },
      authenticated,
    })),
  });

  it("keeps the project/app default when it is connected", () => {
    expect(defaultAgentFor(bundle({ claude: true, codex: true }), null)).toBe("claude");
    expect(defaultAgentFor(bundle({ claude: true, codex: true }), "codex")).toBe("codex");
  });

  it("falls to the first connected agent when the default is not", () => {
    expect(defaultAgentFor(bundle({ claude: false, codex: true }), null)).toBe("codex");
    expect(defaultAgentFor(bundle({ claude: true, codex: false }), "codex")).toBe("claude");
  });

  it("falls back to existence when nothing is connected", () => {
    expect(defaultAgentFor(bundle({ claude: false, codex: false }), null)).toBe("claude");
  });

  // The picker hides when there's nothing to choose. Every driver is always
  // registered, so the "one agent registered" case never fires on a real
  // instance; the case that matters is one agent CONNECTED and already picked.
  describe("agentPickerNeeded", () => {
    it("hides with a single registered agent", () => {
      expect(agentPickerNeeded(bundle({ claude: true }), "claude")).toBe(false);
      expect(agentPickerNeeded(bundle({ claude: false }), "claude")).toBe(false);
    });

    it("hides when the only connected agent is the one selected", () => {
      expect(agentPickerNeeded(bundle({ claude: true, codex: false }), "claude")).toBe(false);
      expect(agentPickerNeeded(bundle({ claude: false, codex: true }), "codex")).toBe(false);
      // What defaultAgentFor picks is what the New-task dialog opens on, so a
      // Claude-only instance never renders the picker for a new task.
      const b = bundle({ claude: true, codex: false });
      expect(agentPickerNeeded(b, defaultAgentFor(b, "codex"))).toBe(false);
    });

    it("shows when the selected agent is NOT the lone connected one", () => {
      // An old Codex task in Edit, or a project default that was signed out:
      // the picker is the way off it and carries the Connect CTA.
      expect(agentPickerNeeded(bundle({ claude: true, codex: false }), "codex")).toBe(true);
    });

    it("shows when two or more agents are connected", () => {
      expect(agentPickerNeeded(bundle({ claude: true, codex: true }), "claude")).toBe(true);
    });

    // The third driver is a third entry in the same bundle. Neither the default
    // nor this predicate counts agents, so this is the whole "does a third
    // agent id work" test the mock driver can't stand in for (its id is fixed
    // at "mock", so the onboarding e2e can only ever exercise one extra). What
    // the picker OFFERS does change with a third driver; that's pickerAgents
    // below.
    it("treats a third agent id exactly like the second", () => {
      const only = bundle({ claude: false, codex: false, gemini: true });
      expect(defaultAgentFor(only, null)).toBe("gemini");
      expect(defaultAgentFor(only, "codex")).toBe("gemini");
      expect(agentPickerNeeded(only, "gemini")).toBe(false);
      expect(agentPickerNeeded(only, "claude")).toBe(true);
      const all = bundle({ claude: true, codex: true, gemini: true });
      expect(defaultAgentFor(all, "gemini")).toBe("gemini");
      expect(agentPickerNeeded(all, "gemini")).toBe(true);
    });

    it("shows when nothing is connected, so the Connect CTA still renders", () => {
      expect(agentPickerNeeded(bundle({ claude: false, codex: false }), "claude")).toBe(true);
    });
  });

  // What the picker RENDERS, which hiding it was only ever a special case of.
  // With two drivers the two questions coincided: hide the picker and the dead
  // "not connected" button went with it. A third driver split them — a
  // Claude + Antigravity instance has a real choice, so the picker shows, and
  // an unconnected Codex was riding along inside it.
  const ids = (b: AgentsBundle, value: string) => pickerAgents(b, value).map((a) => a.id);

  describe("pickerAgents", () => {
    it("offers only the connected agents", () => {
      expect(ids(bundle({ claude: true, codex: false, gemini: true }), "claude")).toEqual(["claude", "gemini"]);
      // The New-task dialog opens on defaultAgentFor(), so this is the exact
      // list the reported regression rendered.
      const b = bundle({ claude: true, codex: false, gemini: true });
      expect(ids(b, defaultAgentFor(b, null))).not.toContain("codex");
    });

    it("keeps an unconnected agent when it is the one selected", () => {
      // An old Codex task in Edit, or a project default that was signed out:
      // dropping it would leave the picker with nothing on and no way off.
      expect(ids(bundle({ claude: true, codex: false, gemini: true }), "codex")).toEqual(["claude", "gemini", "codex"]);
    });

    it("offers everything when nothing is connected, so the CTA has a target", () => {
      expect(ids(bundle({ claude: false, codex: false, gemini: false }), "claude")).toEqual(["claude", "codex", "gemini"]);
    });

    // The schedule and runbook agent pickers (app/shell/Schedules.tsx,
    // app/shell/Runbooks.tsx) render this same list rather than a second
    // filter, since both mint a task and preflight on "agent connected" — an
    // unconnected choice there is a schedule that settles every occurrence
    // `failed`, or a runbook button that fails on press. This is that
    // contract, named for those two callers so a future edit to pickerAgents
    // can't forget who else depends on it.
    it("keeps a saved schedule/runbook agent selected even when it was since signed out", () => {
      // Editing a schedule or runbook whose saved agent is no longer connected
      // must still show that agent as the selected <option>, flagged, rather
      // than silently re-pointing saved automation at a different driver.
      expect(ids(bundle({ claude: true, codex: false, gemini: true }), "codex")).toContain("codex");
    });

    it("excludes an unconnected agent nobody has selected, unlike a raw driver list", () => {
      // What the old Schedules/Runbooks <select> did: list every registered
      // driver and suffix "(not connected)" on the dead ones. pickerAgents
      // drops them instead of merely flagging them.
      const b = bundle({ claude: true, codex: false, gemini: true });
      expect(ids(b, "claude")).toEqual(["claude", "gemini"]);
      expect(ids(b, "claude")).not.toContain("codex");
    });

    it("agrees with agentPickerNeeded about there being a choice", () => {
      // The picker must never render a single button that is already selected,
      // and must never hide while it still had a second entry to offer.
      for (const authed of [
        { claude: true, codex: false, gemini: false },
        { claude: true, codex: false, gemini: true },
        { claude: false, codex: false, gemini: false },
        { claude: true, codex: true, gemini: true },
      ]) {
        for (const value of ["claude", "codex", "gemini"]) {
          const b = bundle(authed, "claude");
          const offered = ids(b, value);
          const alone = offered.length === 1 && offered[0] === value;
          expect(agentPickerNeeded(b, value)).toBe(!alone);
        }
      }
    });
  });
});

// suggest_task mints tasks with no user in the loop, so nothing downstream can
// correct a bad agent choice — and a task's agent is fixed for its whole life.
describe("suggested tasks are born on a connected agent", () => {
  beforeEach(resetSettings);

  it("overrides an unconnected project default with the connected agent", () => {
    setSetting("default_agent", "claude");
    const project = createProject({ name: "SuggestCodexOnly" });
    expect(project.default_agent).toBe("claude");
    connect("codex"); // claude never connected
    const { task } = createSuggestedTask(project, { title: "Proposed", description: "" });
    expect(getTask(task!.id)?.agent).toBe("codex");
  });

  it("keeps the project default when it IS connected", () => {
    setSetting("default_agent", "claude");
    const project = createProject({ name: "SuggestBoth" });
    connect("claude");
    connect("codex");
    const { task } = createSuggestedTask(project, { title: "Proposed", description: "" });
    expect(getTask(task!.id)?.agent).toBe("claude");
  });

  it("falls back to the project default when nothing is connected", () => {
    setSetting("default_agent", "claude");
    const project = createProject({ name: "SuggestNone" });
    const { task } = createSuggestedTask(project, { title: "Proposed", description: "" });
    expect(getTask(task!.id)?.agent).toBe("claude");
  });
});

describe("completeOnboarding adopts the connected agent", () => {
  beforeEach(resetSettings);

  it("retargets the app default and the seeded tutorial on a Codex-only run", () => {
    const project = createProject({ name: "WelcomeSeed" });
    getDb().prepare("UPDATE projects SET seeded = 1, default_agent = 'claude' WHERE id = ?").run(project.id);
    const fresh = createTask({ project_id: project.id, title: "Tutorial", description: "" });
    const started = createTask({ project_id: project.id, title: "Started", description: "" });
    updateTask(started.id, { started: 1 });
    getDb().prepare("UPDATE tasks SET agent = 'claude' WHERE id IN (?, ?)").run(fresh.id, started.id);

    connect("codex"); // claude never connected
    completeOnboarding();

    expect(getSetting("default_agent")).toBe("codex");
    const proj = getDb().prepare("SELECT default_agent FROM projects WHERE id = ?").get(project.id) as { default_agent: string };
    expect(proj.default_agent).toBe("codex");
    expect(getTask(fresh.id)?.agent).toBe("codex");
    // A task that already ran keeps its agent — a session lineage can't switch CLIs.
    expect(getTask(started.id)?.agent).toBe("claude");
  });

  it("finishes a first run with ONLY Antigravity connected", () => {
    const project = createProject({ name: "WelcomeSeedGemini" });
    getDb().prepare("UPDATE projects SET seeded = 1, default_agent = 'claude' WHERE id = ?").run(project.id);
    const fresh = createTask({ project_id: project.id, title: "Tutorial", description: "" });
    getDb().prepare("UPDATE tasks SET agent = 'claude' WHERE id = ?").run(fresh.id);

    connect("gemini");
    completeOnboarding();

    expect(getSetting("default_agent")).toBe("gemini");
    expect(getTask(fresh.id)?.agent).toBe("gemini");
    // …and a task suggested afterwards is born on it too.
    const { task } = createSuggestedTask(project, { title: "Proposed", description: "" });
    expect(getTask(task!.id)?.agent).toBe("gemini");
  });

  it("changes nothing when the default agent is connected", () => {
    connect("claude");
    connect("codex");
    completeOnboarding();
    expect(getSetting("default_agent")).toBeNull();
  });

  it("changes nothing when no agent is connected (skip setup)", () => {
    completeOnboarding();
    expect(getSetting("default_agent")).toBeNull();
  });
});
