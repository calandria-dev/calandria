import { describe, expect, it } from "vitest";
import { isTypingTarget, stepTask, taskKeyAction } from "../app/shell/taskKeys";

// A stand-in element: `closest` answers true when any selector in the list
// names one of the ancestors this fake sits inside.
function el(ancestors: string[], opts: { editable?: boolean } = {}) {
  return {
    isContentEditable: !!opts.editable,
    closest: (sel: string) => {
      const parts = sel.split(",").map((s) => s.trim());
      return parts.some((p) => ancestors.includes(p)) ? {} : null;
    },
  };
}

function key(k: string, target: ReturnType<typeof el> | null = el([]), mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented", boolean>> = {}) {
  return { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target, ...mods };
}

describe("taskKeyAction", () => {
  it("maps the handoff keys", () => {
    expect(taskKeyAction(key("j"))).toBe("next");
    expect(taskKeyAction(key("k"))).toBe("prev");
    expect(taskKeyAction(key("Enter"))).toBe("open");
    expect(taskKeyAction(key("t"))).toBe("terminal");
    expect(taskKeyAction(key("d"))).toBe("diff");
    expect(taskKeyAction(key("n"))).toBe("new");
    expect(taskKeyAction(key("x"))).toBeNull();
    expect(taskKeyAction(key("J"))).toBeNull();
  });

  it("ignores a key while a modifier is held", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      expect(taskKeyAction(key("j", el([]), { [mod]: true }))).toBeNull();
    }
  });

  it("ignores a composing or already-handled key", () => {
    expect(taskKeyAction(key("n", el([]), { isComposing: true }))).toBeNull();
    expect(taskKeyAction(key("Enter", el([]), { defaultPrevented: true }))).toBeNull();
  });

  it("ignores a key while focus is where text goes", () => {
    for (const where of ["input", "textarea", "select", ".cm-editor", ".xterm", ".term-host"]) {
      expect(taskKeyAction(key("j", el([where])))).toBeNull();
    }
    expect(taskKeyAction(key("d", el([], { editable: true })))).toBeNull();
  });

  it("leaves Enter to a focused control but keeps the letter keys", () => {
    expect(taskKeyAction(key("Enter", el(["button"])))).toBeNull();
    expect(taskKeyAction(key("Enter", el(["a[href]"])))).toBeNull();
    expect(taskKeyAction(key("j", el(["button"])))).toBe("next");
  });

  it("treats a missing target as the page body", () => {
    expect(taskKeyAction(key("n", null))).toBe("new");
  });
});

describe("isTypingTarget", () => {
  it("is false for a plain element and null", () => {
    expect(isTypingTarget(el(["div"]))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("stepTask", () => {
  const ids = ["a", "b", "c"];
  it("moves one step and clamps at both ends", () => {
    expect(stepTask(ids, "a", 1)).toBe("b");
    expect(stepTask(ids, "b", -1)).toBe("a");
    expect(stepTask(ids, "c", 1)).toBe("c");
    expect(stepTask(ids, "a", -1)).toBe("a");
  });
  it("starts at the first for j and the last for k with nothing selected", () => {
    expect(stepTask(ids, null, 1)).toBe("a");
    expect(stepTask(ids, null, -1)).toBe("c");
    expect(stepTask(ids, "gone", 1)).toBe("a");
  });
  it("returns null for an empty list", () => {
    expect(stepTask([], null, 1)).toBeNull();
  });
});
