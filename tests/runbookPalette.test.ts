import { describe, expect, it } from "vitest";
import { fuzzyScore } from "@/app/shell/CommandPalette";

// The palette is the accelerator that decides whether runbooks get used daily:
// ⌘K, three letters, Enter. These pin that a runbook row wins on the letters
// somebody would actually type for it — and, since the label shape is a design
// choice ("Run: X" rather than "Runbook — X"), that changing it is a decision
// rather than an accident.
describe("runbook palette rows", () => {
  const label = (name: string) => `Run: ${name}`;

  it("matches on the runbook's own name, not just the Run: prefix", () => {
    expect(fuzzyScore("babysit", label("Push & babysit CI"))).toBeGreaterThan(0);
    expect(fuzzyScore("pbc", label("Push & babysit CI"))).toBeGreaterThan(0);
  });

  it("ranks the intended runbook above an unrelated one", () => {
    const wanted = fuzzyScore("sweep", label("Jira sweep"));
    const other = fuzzyScore("sweep", label("Push & babysit CI"));
    expect(wanted).toBeGreaterThan(other);
  });

  it("does not match a query with no relationship to the row", () => {
    expect(fuzzyScore("zzzz", label("Jira sweep"))).toBe(-Infinity);
  });

  // The rows carry `keywords` so "runbook" finds every one of them even when
  // the user can't remember what they named it.
  it("finds every runbook from the word 'runbook' via its keywords", () => {
    const keywords = (name: string, desc: string) => `${label(name)} runbook dispatch ${name} ${desc}`;
    expect(fuzzyScore("runbook", keywords("Jira sweep", "sweep the queue"))).toBeGreaterThan(0);
    expect(fuzzyScore("runbook", keywords("Push & babysit CI", "watch the pipeline"))).toBeGreaterThan(0);
  });
});
