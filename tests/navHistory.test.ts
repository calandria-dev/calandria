import { describe, expect, it } from "vitest";
import { reconcileHistory, closeOneLevel, backOneLevel, selectionUrl, type HistoryLike, type NavSel } from "../app/shell/navHistory";

// A stand-in for window.history: a stack of entries plus a cursor. pushState
// truncates any forward entries (as real browsers do); back() moves the cursor.
class FakeHistory implements HistoryLike {
  stack: { state: unknown; url: string }[];
  idx: number;
  constructor(initialUrl: string) {
    this.stack = [{ state: null, url: initialUrl }];
    this.idx = 0;
  }
  get state() { return this.idx >= 0 ? this.stack[this.idx].state : null; }
  get url() { return this.idx >= 0 ? this.stack[this.idx].url : "(exit)"; }
  pushState(state: unknown, _t: string, url: string) {
    this.stack = this.stack.slice(0, this.idx + 1);
    this.stack.push({ state, url });
    this.idx++;
  }
  replaceState(state: unknown, _t: string, url: string) {
    if (this.idx >= 0) this.stack[this.idx] = { state, url };
  }
  /** Returns false when Back steps off the end (i.e. leaves the app). */
  back(): boolean { this.idx--; return this.idx >= 0; }
}

const PATH = "/app";
const MOBILE = true;

function paneOf(sel: NavSel): "projects" | "tasks" | "project" | "session" | "settings" {
  if (sel.view === "settings") return "settings";
  if (sel.proj && sel.task) return "session";
  if (sel.proj && sel.home) return "project";  // the Runbooks/Schedules pane
  if (sel.proj) return "tasks";
  return "projects";
}

// One app "tick": selection settled to `sel`, so the persist effect reconciles.
function settle(h: FakeHistory, sel: NavSel) {
  reconcileHistory(h, PATH, sel, MOBILE);
}

// Press Back: browser pops; if still in-app, the popstate handler closes one
// level off the *live* selection, then the effect re-arms. Returns the new pane
// (or "exit"). Mutates `ref` to track the live selection across presses.
function pressBack(h: FakeHistory, ref: { sel: NavSel }): string {
  if (!h.back()) return "exit";
  ref.sel = closeOneLevel(ref.sel);
  settle(h, ref.sel);
  return paneOf(ref.sel);
}

const sel = (proj: string | null, task: string | null, view: NavSel["view"] = "workspace"): NavSel =>
  ({ proj, task, home: false, view });

/** The project-home pane: a project open, no task, the home intent held. */
const home = (proj: string): NavSel => ({ proj, task: null, home: true, view: "workspace" });

describe("navHistory — mobile Back via single trap entry", () => {
  it("deep-link to a task: Back steps session → tasks → projects → exit", () => {
    const h = new FakeHistory("/app?project=NB&task=O02");
    const ref = { sel: sel("NB", "O02") };
    settle(h, sel(null, null)); // first effect run: selection still loading
    settle(h, ref.sel);         // async load applies the deep-linked selection
    expect(paneOf(ref.sel)).toBe("session");

    expect(pressBack(h, ref)).toBe("tasks");     // the user's core need: shows all tasks
    expect(pressBack(h, ref)).toBe("projects");
    expect(pressBack(h, ref)).toBe("exit");
  });

  it("is immune to the live task list churning selTask null↔id (the prod bug)", () => {
    const h = new FakeHistory("/app");
    const ref = { sel: sel(null, null) };
    settle(h, ref.sel);
    settle(h, sel("NB", null)); ref.sel = sel("NB", null);
    settle(h, sel("NB", "O02")); ref.sel = sel("NB", "O02");
    const lenAfterOpen = h.stack.length;

    // Background refreshes flip selTask off and on many times while the task is open.
    for (let i = 0; i < 8; i++) {
      settle(h, sel("NB", null));   // recap clears it
      settle(h, sel("NB", "O02"));  // recap re-selects it
    }
    expect(h.stack.length).toBe(lenAfterOpen); // NO duplicate entries piled up

    ref.sel = sel("NB", "O02");
    expect(pressBack(h, ref)).toBe("tasks");     // one Back still escapes the session
    expect(pressBack(h, ref)).toBe("projects");
    expect(pressBack(h, ref)).toBe("exit");
  });

  it("drill in by tapping, Back unwinds one level per press (no replay)", () => {
    const h = new FakeHistory("/app");
    const ref = { sel: sel(null, null) };
    settle(h, ref.sel);                       // projects
    settle(h, sel("P", null)); ref.sel = sel("P", null);   // tap project → tasks
    settle(h, sel("P", "T")); ref.sel = sel("P", "T");     // tap task → session

    expect(pressBack(h, ref)).toBe("tasks");      // not back into the task
    expect(pressBack(h, ref)).toBe("projects");
    expect(pressBack(h, ref)).toBe("exit");
  });

  it("only one trap entry exists at a time regardless of how deep you go", () => {
    const h = new FakeHistory("/app");
    settle(h, sel(null, null));
    settle(h, sel("P", null));
    settle(h, sel("P", "T"));
    const traps = h.stack.filter((e) => (e.state as { trap?: boolean })?.trap).length;
    expect(traps).toBe(1);
  });

  it("settings: Back closes settings back to the workspace", () => {
    const h = new FakeHistory("/app");
    const ref = { sel: sel("P", null, "settings") };
    settle(h, sel(null, null));
    settle(h, ref.sel);
    expect(paneOf(ref.sel)).toBe("settings");
    expect(pressBack(h, ref)).toBe("tasks");  // settings → workspace (project still open)
  });

  it("desktop (armTrap=false) never pushes a trap — Back is not hijacked", () => {
    const h = new FakeHistory("/app");
    reconcileHistory(h, PATH, sel(null, null), false);
    reconcileHistory(h, PATH, sel("P", null), false);
    reconcileHistory(h, PATH, sel("P", "T"), false);
    expect(h.stack.length).toBe(1); // all replaceState, no new entries
    expect(h.url).toBe("?project=P&task=T"); // URL still mirrored for refresh-restore
  });

  // The project home is the only mount point for Runbooks and Schedules, and on
  // a phone it is a pane of its own rather than "no task selected" — so it has
  // to be a Back level, or the one press that should return to the task list
  // would drop the whole project instead.
  it("project home: Back steps project → tasks → projects → exit", () => {
    const h = new FakeHistory("/app");
    const ref = { sel: sel(null, null) };
    settle(h, ref.sel);
    settle(h, sel("P", null)); ref.sel = sel("P", null);   // tap project → tasks
    settle(h, home("P")); ref.sel = home("P");             // tap the name → project home
    expect(paneOf(ref.sel)).toBe("project");

    expect(pressBack(h, ref)).toBe("tasks");
    expect(pressBack(h, ref)).toBe("projects");
    expect(pressBack(h, ref)).toBe("exit");
  });

  it("opening a task from the project home leaves no home level behind", () => {
    // A runbook dispatch selects the task it minted, which drops the intent —
    // one Back must then land on the task list, not back on the cards.
    const h = new FakeHistory("/app");
    const ref = { sel: sel(null, null) };
    settle(h, ref.sel);
    settle(h, home("P"));
    ref.sel = sel("P", "T");   // dispatch selected the new task
    settle(h, ref.sel);
    expect(pressBack(h, ref)).toBe("tasks");
    expect(pressBack(h, ref)).toBe("projects");
  });

  it("project home adds no history entries of its own (still one trap)", () => {
    const h = new FakeHistory("/app");
    settle(h, sel(null, null));
    settle(h, sel("P", null));
    settle(h, home("P"));
    settle(h, sel("P", null));
    settle(h, home("P"));
    expect(h.stack.filter((e) => (e.state as { trap?: boolean })?.trap).length).toBe(1);
  });

  it("deep-link to ?home=1 restores the project home pane", () => {
    const h = new FakeHistory("/app?project=P&home=1");
    const ref = { sel: home("P") };
    settle(h, sel(null, null)); // first effect run: selection still loading
    settle(h, ref.sel);
    expect(paneOf(ref.sel)).toBe("project");
    expect(h.url).toBe("?project=P&home=1");
    expect(pressBack(h, ref)).toBe("tasks");
  });

  it("selectionUrl mirrors selection for refresh-restore", () => {
    expect(selectionUrl(sel(null, null), "/app")).toBe("/app");
    expect(selectionUrl(sel("P", null), "/app")).toBe("?project=P");
    expect(selectionUrl(sel("P", "T"), "/app")).toBe("?project=P&task=T");
    expect(selectionUrl(sel("P", null, "settings"), "/app")).toBe("?project=P&view=settings");
    expect(selectionUrl(home("P"), "/app")).toBe("?project=P&home=1");
    // home never travels without a project, and a selected task supersedes it
    // (selecting one drops the intent) — so neither combination is mirrored.
    expect(selectionUrl({ proj: null, task: null, home: true, view: "workspace" }, "/app")).toBe("/app");
    expect(selectionUrl({ proj: "P", task: "T", home: true, view: "workspace" }, "/app")).toBe("?project=P&task=T");
  });
});

// The on-screen Back buttons ("Back to projects", "Back to tasks") go through
// backOneLevel. Pressing one is the same as the device button when the trap is
// armed, and must still close the pane when it isn't — the trap is armed by a
// passive effect one paint after the button is tappable.
describe("navHistory — the in-app Back button acts on the history it finds", () => {
  // The button's press: what the shell's goBack does, minus React.
  function pressButton(h: FakeHistory, ref: { sel: NavSel }): { via: "history" | "state"; pane: string } {
    const via = backOneLevel(h, ref.sel, (next) => { ref.sel = next; });
    // "history": the browser pops, then the popstate handler closes the level
    // off the live selection, exactly as pressBack models it.
    if (via === "history") ref.sel = closeOneLevel(ref.sel);
    settle(h, ref.sel);
    return { via, pane: paneOf(ref.sel) };
  }

  it("with the trap armed, pops it — so the device button and the on-screen one leave the same history", () => {
    const h = new FakeHistory("/app");
    const ref = { sel: sel("P", "T") };
    settle(h, ref.sel);
    expect(h.stack.length).toBe(2);
    expect(pressButton(h, ref)).toEqual({ via: "history", pane: "tasks" });
    expect(h.stack.length).toBe(2); // the trap re-armed for the task list
    expect(pressButton(h, ref)).toEqual({ via: "history", pane: "projects" });
    expect(h.idx).toBe(0); // back on the root entry, nothing armed there
    expect(h.url).toBe("/app");
    expect(pressBack(h, ref)).toBe("exit");
  });

  it("pressed before the arming effect has run, closes the level itself instead of leaving the app", () => {
    // Boot landed on P's task list and painted its Back button; the persist
    // effect that would push the trap hasn't had its turn.
    const h = new FakeHistory("/app");
    const ref = { sel: sel("P", null) };
    expect(h.stack.length).toBe(1);
    expect(pressButton(h, ref)).toEqual({ via: "state", pane: "projects" });
    // Still in the app, on the projects list, with the URL mirrored and no
    // trap: the next device Back leaves, as it should at the root.
    expect(h.idx).toBe(0);
    expect(h.url).toBe("/app");
    expect(pressBack(h, ref)).toBe("exit");
  });

  it("pressed before the trap is armed on a deeper pane, closes one level and the effect then arms for the rest", () => {
    const h = new FakeHistory("/app");
    const ref = { sel: sel("P", "T") };
    expect(pressButton(h, ref)).toEqual({ via: "state", pane: "tasks" });
    expect(h.stack.length).toBe(2); // the settle armed the trap for the task list
    expect(pressBack(h, ref)).toBe("projects");
    expect(pressBack(h, ref)).toBe("exit");
  });
});
