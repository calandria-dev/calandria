import { describe, it, expect } from "vitest";
import { INHERIT_LABEL, modelOptions, permissionOptions, reasoningOptions } from "@/app/shell/types";
import { getCapabilities, listAgentIds } from "@/lib/agents/capabilities";

// The synthetic head every run-control picker is built from (withInherit() in
// app/shell/types.ts) versus the provider's own option labels, which are
// deliberately the driver's native spellings — Anthropic's `--permission-mode`
// strings among them, one of which is literally "default".
//
// That collision is the bug this pins: a head labelled "Default" sat one row
// above Claude's own "default" mode, differing only in case, and reading as a
// duplicate. The head owns a word no provider uses, and it must be the SAME
// word in all three pickers (model / reasoning / permission) — a per-picker
// synonym is how the vocabulary drifts back apart.
const PICKERS = { model: modelOptions, reasoning: reasoningOptions, permission: permissionOptions } as const;

describe("the pickers' inherit head", () => {
  it("leads every picker, carries the null value, and is spelled the same in all of them", () => {
    for (const id of listAgentIds()) {
      const caps = getCapabilities(id);
      for (const [name, build] of Object.entries(PICKERS)) {
        const head = build(caps)[0];
        expect(head, `${id}/${name}`).toBeDefined();
        expect(head.value, `${id}/${name}`).toBeNull();
        expect(head.label, `${id}/${name}`).toBe(INHERIT_LABEL);
        expect(head.sub.trim(), `${id}/${name}`).not.toBe("");
      }
    }
  });

  it("never collides with a provider's own label, case-insensitively", () => {
    // Case is the ONLY thing that separated "Default" from Claude's "default",
    // so the guard has to be case-insensitive or it would have passed on the
    // very state it exists to prevent.
    const head = INHERIT_LABEL.toLowerCase();
    for (const id of listAgentIds()) {
      const caps = getCapabilities(id);
      for (const [name, build] of Object.entries(PICKERS)) {
        for (const o of build(caps).slice(1)) {
          expect(o.label.toLowerCase(), `${id}/${name} option "${o.label}"`).not.toBe(head);
        }
      }
    }
  });

  it("takes a per-surface sub, since what the head inherits differs by surface", () => {
    // Settings → Run defaults IS the app-level default, so there the head hands
    // the choice to the driver rather than to a setting above it. Only the sub
    // changes — the label is fixed so the two surfaces read as one control.
    const caps = getCapabilities("claude");
    const head = permissionOptions(caps, "hand the choice to Claude Code's own default")[0];
    expect(head.label).toBe(INHERIT_LABEL);
    expect(head.sub).toBe("hand the choice to Claude Code's own default");
    // The override is per-call, not a mutation of the shared head object.
    expect(permissionOptions(caps)[0].sub).toBe("use the app-level default");
  });
});
