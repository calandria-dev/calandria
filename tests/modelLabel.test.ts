// The model badge exists to answer one question: which model did this turn
// actually run on? Family aliases move — "opus" resolved to claude-opus-4-8
// before it resolved to claude-opus-5 — so a badge that reads just "Opus" is
// worse than no badge. These pin the version (and the 1M variant) surviving.
import { describe, it, expect } from "vitest";
import { modelLabel, contextWindowOf } from "@/app/shell/format";
import { CLAUDE_CAPABILITIES } from "@/lib/agents/claude/capabilities";
import { CODEX_CAPABILITIES } from "@/lib/agents/codex/capabilities";

const claude = CLAUDE_CAPABILITIES;

describe("modelLabel", () => {
  it("keeps the version, so Opus 5 never reads as bare Opus", () => {
    expect(modelLabel("claude-opus-5", claude)).toBe("Opus 5");
    expect(modelLabel("claude-opus-4-8", claude)).toBe("Opus 4.8");
    expect(modelLabel("claude-opus-4-8-20251101", claude)).toBe("Opus 4.8");
    expect(modelLabel("claude-sonnet-5", claude)).toBe("Sonnet 5");
    expect(modelLabel("claude-fable-5", claude)).toBe("Fable 5");
    // The pinned 5.1 id must not be shadowed by the shorter `claude-fable-5`
    // reading, and must not drag the plain 5 id up to it either.
    expect(modelLabel("claude-fable-5-1", claude)).toBe("Fable 5.1");
    expect(modelLabel("claude-haiku-4-5", claude)).toBe("Haiku 4.5");
  });

  it("marks the 1M-context variant as a distinct run mode", () => {
    expect(modelLabel("claude-opus-5[1m]", claude)).toBe("Opus 5 (1M)");
    expect(modelLabel("claude-sonnet-4-6[1m]", claude)).toBe("Sonnet 4.6 (1M)");
  });

  it("falls back to capability labels for ids with no version shape", () => {
    expect(modelLabel("gpt-5.5", CODEX_CAPABILITIES)).toBe("GPT-5.5");
    expect(modelLabel("gpt-5.6-sol", CODEX_CAPABILITIES)).toBe("GPT-5.6 Sol");
    // "gpt-5.6-terra" also contains "gpt-5.6" — longest-first matching must not
    // let a shorter value shadow the more specific one.
    expect(modelLabel("gpt-5.6-terra", CODEX_CAPABILITIES)).toBe("GPT-5.6 Terra");
  });

  it("degrades to the family, then the raw id", () => {
    expect(modelLabel("claude-opus-latest", claude)).toBe("Opus");
    expect(modelLabel("some-unknown-model")).toBe("some-unknown-model");
    expect(modelLabel(null)).toBe("");
  });
});

describe("claude model list", () => {
  it("offers unique values and labels (the picker keys on label)", () => {
    expect(new Set(claude.models.map((m) => m.value)).size).toBe(claude.models.length);
    expect(new Set(claude.models.map((m) => m.label)).size).toBe(claude.models.length);
  });

  it("groups options contiguously so one header renders per section", () => {
    const seen: string[] = [];
    for (const m of claude.models) {
      const g = m.group ?? "";
      if (seen[seen.length - 1] !== g) {
        expect(seen).not.toContain(g); // a group must not resume after another
        seen.push(g);
      }
    }
    expect(seen.length).toBeGreaterThan(1);
  });

  it("sizes the context gauge per selected variant, not per family", () => {
    expect(contextWindowOf("opus", claude)).toBe(200_000);
    expect(contextWindowOf("opus[1m]", claude)).toBe(1_000_000);
    expect(contextWindowOf("fable", claude)).toBe(1_000_000);
    expect(contextWindowOf("claude-fable-5-1", claude)).toBe(1_000_000);
  });

  // Issue #39: the two misses are different questions. An inherited (null)
  // model may be the 1M variant, so the gauge assumes the widest window; an id
  // the catalog doesn't know gets the NARROWEST, so it over-reports fullness
  // rather than promising headroom it can't vouch for.
  it("assumes the widest window for an inherited model and the narrowest for an unknown id", () => {
    const widest = Math.max(...claude.models.map((m) => m.contextWindow));
    const narrowest = Math.min(...claude.models.map((m) => m.contextWindow));
    expect(widest).toBeGreaterThan(narrowest);
    expect(contextWindowOf(null, claude)).toBe(widest);
    expect(contextWindowOf("claude-from-the-future", claude)).toBe(narrowest);
    expect(contextWindowOf("anything", { ...claude, models: [] })).toBe(200_000);
    expect(contextWindowOf(null, undefined)).toBe(200_000);
  });
});
