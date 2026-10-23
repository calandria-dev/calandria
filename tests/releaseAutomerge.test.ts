import { describe, it, expect } from "vitest";

import {
  headReadiness,
  READY_REQUIRED,
  disqualifier,
  releaseEligibility,
  PIN_DRIFT_BRANCH,
} from "../scripts/release-automerge-eligible.mjs";

// The release PR merges itself only when every commit since the last tag is a
// bot dependency bump. Each case below is one way a commit keeps the release
// with a person (.github/CLAUDE.md).

const pinDrift = (subject = "build(deps): bump Antigravity CLI to 1.3.5") => ({
  sha: "6a568fe0000000",
  subject,
  pr: { author: "github-actions[bot]", head: PIN_DRIFT_BRANCH },
});
const dependabot = (subject: string) => ({
  sha: "abcdef1234567",
  subject,
  pr: { author: "dependabot[bot]", head: "dependabot/docker/node-26" },
});

describe("release auto-merge eligibility", () => {
  it("accepts a range of pin-drift and scoped Dependabot bumps", () => {
    expect(
      releaseEligibility([
        pinDrift(),
        dependabot("build(deps): bump node from 26.1.0 to 26.1.1 in the base-image group"),
        dependabot("build(deps-dev): bump typescript in /website"),
        dependabot("ci(deps): bump the actions group with 3 updates"),
      ]),
    ).toEqual({ eligible: true, reasons: [] });
  });

  it("refuses an empty range", () => {
    expect(releaseEligibility([]).eligible).toBe(false);
  });

  it("refuses a human commit even when it is titled as a dependency bump", () => {
    const human = { ...pinDrift("build(deps): refresh agent CLI pins"), pr: { author: "penmoid", head: "fix-pins" } };
    expect(disqualifier(human)).toMatch(/authored by penmoid/);
    expect(releaseEligibility([pinDrift(), human]).eligible).toBe(false);
  });

  it("refuses a commit that reached main with no pull request", () => {
    expect(disqualifier({ ...pinDrift(), pr: null })).toMatch(/without a pull request/);
  });

  it("refuses github-actions[bot] from any branch other than the pin-drift branch", () => {
    expect(disqualifier({ ...pinDrift(), pr: { author: "github-actions[bot]", head: "bot/other" } })).toMatch(
      /not bot\/agent-cli-pins/,
    );
  });

  it("refuses a bot commit whose subject is not a deps-scoped bump", () => {
    expect(disqualifier(pinDrift("fix: something else"))).not.toBeNull();
    expect(disqualifier(dependabot("build: bump smol-toml from 1.8.0 to 1.9.0 in /website"))).toMatch(
      /without a deps scope/,
    );
    expect(disqualifier(dependabot("feat(deps): bump x"))).not.toBeNull();
  });
});

describe("release PR head readiness", () => {
  const green = (name: string, id = 1) => ({ id, name, status: "completed", conclusion: "success" });
  const allGreen = READY_REQUIRED.map((name, i) => green(name, i + 1));

  it("is ready when every required lane passed and nothing failed or is running", () => {
    const runs = [...allGreen, { id: 90, name: "Desktop shell (Electron, macOS)", status: "completed", conclusion: "skipped" }];
    expect(headReadiness(runs, [{ context: "Desktop release artifacts", state: "success" }])).toEqual({
      ready: true,
      pending: [],
      failed: [],
      missing: [],
    });
  });

  it("waits on a skipped e2e lane, the unlabeled release PR case", () => {
    const runs = allGreen.map((r) =>
      r.name === "End-to-end (Playwright)" ? { ...r, conclusion: "skipped" } : r,
    );
    expect(headReadiness(runs, [])).toMatchObject({ ready: false, missing: ["End-to-end (Playwright)"] });
  });

  it("counts only the newest run per name, so a cancelled predecessor is ignored", () => {
    const runs = [
      ...allGreen.map((r) => ({ ...r, id: r.id + 100 })),
      { id: 1, name: "Unit (vitest)", status: "completed", conclusion: "cancelled" },
    ];
    expect(headReadiness(runs, []).ready).toBe(true);
  });

  it("is not ready while a run is in progress or after one failed", () => {
    expect(headReadiness([...allGreen, { id: 50, name: "Types (tsc)", status: "in_progress", conclusion: null }], []))
      .toMatchObject({ ready: false, pending: ["Types (tsc)"] });
    expect(headReadiness([...allGreen, { id: 50, name: "Types (tsc)", status: "completed", conclusion: "failure" }], []))
      .toMatchObject({ ready: false, failed: ["Types (tsc) (failure)"] });
  });

  it("reads the newest commit status per context, so a stale-prebuild failure blocks", () => {
    expect(
      headReadiness(allGreen, [
        { context: "Desktop release artifacts", state: "failure" },
        { context: "Desktop release artifacts", state: "success" },
      ]),
    ).toMatchObject({ ready: false, failed: ["Desktop release artifacts (failure)"] });
  });
});
