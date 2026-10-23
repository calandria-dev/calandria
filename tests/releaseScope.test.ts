// Which commits release-please is allowed to turn into a release.
//
// A squash subject decides the next version and the changelog line. CI repair
// work lands as `fix(ci): ...` often enough that it was cutting patch releases
// of its own and filling "Bug Fixes" with entries that changed nothing a user
// runs: #392 and #394 both touched only `.github/workflows/`.
//
// Type alone cannot separate those cases. `fix(ci): upgrade base packages so
// the weekly image scan can pass` (#366) edited the Dockerfile, which ships,
// and belongs in the notes. The path set a commit touches is the fact that
// distinguishes them, so `exclude-paths` carries the policy: a commit whose
// files all sit under one of these paths is dropped from version selection and
// from CHANGELOG.md, whatever its type, and a commit that touches an excluded
// path together with anything else still counts in full.
//
// JSON takes no comments, so this test holds the reasoning for the three
// entries, and fails if one is dropped:
//
//   website  - the marketing site, deployed by website.yml on its own.
//   .github  - workflows, issue templates and the agent notes beside them.
//   .claude  - this repository's own development tooling, which is never
//              installed into a user's project (skills/ is, and is not here).
//
// `changelog-sections` replaces release-please's default table, so it lists
// every type. `build` is the one visible change from the defaults: a
// dependency bump (`build(deps): ...` from pin-drift.yml and Dependabot) cuts
// a patch release and is listed under "Dependencies". release-please opens a
// release PR only for commits in a visible section, so a hidden `build` left
// a dependency-only merge with no release at all.
//
// tests/desktopRelease.test.ts pins the rest of release-please-config.json.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

const config = JSON.parse(fs.readFileSync(path.join(ROOT, "release-please-config.json"), "utf8")) as {
  "changelog-sections"?: { type: string; section: string; hidden?: boolean }[];
  packages: Record<string, { "exclude-paths"?: string[] }>;
};

describe("release scope", () => {
  it("keeps CI-only and tooling-only commits out of releases", () => {
    // Manifest mode: `exclude-paths` is a per-package option, and this
    // repository has exactly one package at the root.
    const excluded = config.packages["."]?.["exclude-paths"] ?? [];
    expect(excluded).toContain("website");
    expect(excluded).toContain(".github");
    expect(excluded).toContain(".claude");
  });

  it("excludes only paths that exist and that ship nothing", () => {
    const excluded = config.packages["."]?.["exclude-paths"] ?? [];
    for (const entry of excluded) {
      expect(fs.existsSync(path.join(ROOT, entry))).toBe(true);
    }
    // skills/ is installed into users' projects by scripts/install-skills.sh,
    // so a change there is a product change and stays releasable.
    expect(excluded).not.toContain("skills");
  });

  it("releases dependency bumps and keeps CI, tooling and chores hidden", () => {
    const sections = config["changelog-sections"] ?? [];
    const visible = sections.filter((s) => !s.hidden).map((s) => s.type).sort();
    expect(visible).toEqual(["build", "feat", "feature", "fix", "perf", "revert"]);
    expect(sections.find((s) => s.type === "build")?.section).toBe("Dependencies");
    for (const type of ["ci", "chore", "docs", "refactor", "style", "test"]) {
      expect(sections.find((s) => s.type === type)?.hidden, type).toBe(true);
    }
  });
});
