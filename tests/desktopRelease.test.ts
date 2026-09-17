// The wiring that decides where a release's desktop artifacts land, and under
// what version. None of it can be exercised without cutting a real release, and
// every failure mode is silent: nothing throws, nothing goes red, the
// artifacts simply end up somewhere nobody looks.
//
// Four facts are pinned:
//
//   1. desktop/package.json's version equals the release manifest's. This is not
//      tidiness. electron-builder's github publisher looks the Release up BY TAG
//      and derives that tag from `v${version}` in desktop/package.json, so a
//      desktop package left behind during a release does not fail: it creates a
//      DRAFT release named after the stale version, uploads every artifact into
//      it, and leaves the real Release holding nothing but the Docker image.
//   2. release-please-config.json carries the `extra-files` entry that keeps (1)
//      true without anyone remembering to. JSON takes no comments, so this test
//      is the only place that reasoning can live next to the configuration.
//   3. The `publish` block exists and names this repository. Its presence is
//      what makes electron-builder write latest.yml / latest-mac.yml /
//      latest-linux.yml and the .blockmap files beside each artifact, the feed
//      electron-updater reads. Without it a release publishes downloads that no
//      updater can ever discover.
//   4. That block says `releaseType: "release"`. This one is not hypothetical:
//      several early releases had zero assets attached. electron-publish
//      defaults the type to "draft"; release-please has already cut a
//      published release for the tag; the publisher finds them incompatible,
//      logs `GitHub release not created … existingType=release
//      publishingType=draft`, logs `skipped publishing` once per artifact,
//      installers and update feeds alike, and exits 0. The lane now also
//      asserts the assets really landed, because this publisher's way of
//      refusing is to keep going.
//
// tests/desktopSigning.test.ts pins the other half of this config: that it is
// found at all, and that signing is off unless asked for.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const DESKTOP = path.join(ROOT, "desktop");

// desktop/ has its own package tree (Electron is never installed in the app's),
// so its files are loaded by absolute path rather than through "@/*".
const require = createRequire(import.meta.url);

const readJson = (...segments: string[]) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, ...segments), "utf8"));

describe("desktop release version", () => {
  it("keeps desktop/package.json at the version release-please last shipped", () => {
    const manifest = readJson(".release-please-manifest.json") as Record<string, string>;
    const pkg = readJson("desktop", "package.json") as { version: string };
    expect(pkg.version).toBe(manifest["."]);
  });

  it("has release-please rewrite desktop/package.json on every bump", () => {
    const config = readJson("release-please-config.json") as {
      packages: Record<string, { "extra-files"?: Array<{ type: string; path: string; jsonpath?: string }> }>;
    };
    // Manifest mode: `extra-files` is a per-package option, not a top-level one,
    // and this repository has exactly one package at the root.
    const extras = config.packages["."]?.["extra-files"] ?? [];
    expect(extras).toContainEqual({
      type: "json",
      path: "desktop/package.json",
      jsonpath: "$.version",
    });
  });
});

describe("desktop release publishing", () => {
  it("publishes to this repository's GitHub Releases, so the update feed lands with the artifacts", () => {
    // The config reads process.env; scrub the signing variables so a developer
    // with an Apple ID exported loads the same object CI does.
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("APPLE_") || key.startsWith("CALANDRIA_MAC_") || key.startsWith("AZURE_")) {
        delete process.env[key];
      }
    }
    try {
      const configPath = path.join(DESKTOP, "electron-builder.cjs");
      delete require.cache[configPath];
      const config = require(configPath) as {
        publish: Array<{ provider: string; owner: string; repo: string; releaseType: string }>;
        nsis: { artifactName?: string };
      };
      expect(config.publish).toEqual([
        { provider: "github", owner: "calandria-dev", repo: "calandria", releaseType: "release" },
      ]);
      expect(config.nsis.artifactName).toBe("Calandria-Setup-${version}.${ext}");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

// The `publish` block pinned above is required for a release to work, and it
// also determines whether every other lane fails unless it says otherwise.
// electron-builder does not treat a missing `--publish` as "don't":
// PublishManager fills the policy in itself, and on CI with no tag that
// default is `onTagOrDraft`, which still constructs a GitHubPublisher to go
// looking for a draft. That constructor throws before it does anything
// useful:
//
//   Error: GitHub Personal Access Token is not set, neither programmatically,
//   nor using env "GH_TOKEN"
//
// So `npx electron-builder --win nsis` fails after a full package build, at the
// last step, for a credential the lane has no business holding.
//
// That is not hypothetical: it went red on the first push to main that packaged
// a real Windows target, stayed red across several consecutive pushes, and took
// a release's desktop artifacts and Docker image with it, because both publish
// workflows refuse a tag whose push-to-main Test run is not green. Nobody caught
// it on a pull request: electron-publish's isPullRequest() reads a non-empty
// GITHUB_BASE_REF and skips publishing outright, so the PR that introduced the
// `publish` block was structurally incapable of showing the bug it introduced.
//
// A grep is a poor test of a workflow and a good test of exactly this, because
// the defect is a missing argument on a command line: there is nothing to
// import, nothing to call, and the only way to observe it otherwise is to cut a
// release and watch it not happen.
describe("no lane publishes by accident", () => {
  const WORKFLOWS = path.join(ROOT, ".github", "workflows");
  const RELEASE_WORKFLOW = fs.readFileSync(path.join(WORKFLOWS, "release-desktop.yml"), "utf8");

  const RELEASE_LANE = "release-desktop.yml";

  const invocations = fs
    .readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .flatMap((name) =>
      fs
        .readFileSync(path.join(WORKFLOWS, name), "utf8")
        .split("\n")
        .map((line, index) => ({ file: name, line: index + 1, text: line.trim() }))
        // Comments discuss these commands at length; only the ones a runner
        // executes count.
        .filter(({ text }) => !text.startsWith("#") && /(^|\s)npx electron-builder\b/.test(text)),
    );

  // Without this the whole block passes vacuously the day someone renames a
  // workflow, moves packaging into a composite action, or drops `npx`.
  it("finds the packaging commands it is meant to be guarding", () => {
    const files = new Set(invocations.map((i) => i.file));
    expect(files).toContain("test.yml");
    expect(files).toContain("desktop-bench.yml");
    expect(files).toContain(RELEASE_LANE);
    // Three lanes in test.yml (linux, win, mac), one on the bench, one release.
    expect(invocations.length).toBeGreaterThanOrEqual(5);
  });

  it("passes --publish never everywhere but the release lane", () => {
    const offenders = invocations
      .filter((i) => i.file !== RELEASE_LANE)
      .filter((i) => !/--publish\s+never\b/.test(i.text))
      .map((i) => `${i.file}:${i.line}: ${i.text}`);
    expect(offenders).toEqual([]);
  });

  it("has the release lane publish only from a tag", () => {
    expect(RELEASE_WORKFLOW).toContain('pull_request_target:');
    expect(RELEASE_WORKFLOW).toContain('branches: ["**"]');
    expect(RELEASE_WORKFLOW).toContain('if [ "$BASE_REF" = "main" ] && [ "$HEAD_REF" = "$RELEASE_BRANCH" ]; then');
    expect(RELEASE_WORKFLOW).toContain('if [ "$HEAD_REPOSITORY" != "$GITHUB_REPOSITORY" ]; then');
    expect(RELEASE_WORKFLOW).toContain('types: [opened, synchronize, reopened]');
    expect(RELEASE_WORKFLOW).toContain('push:\n    tags: ["v*"]');
    expect(RELEASE_WORKFLOW).toContain('if [ "$GITHUB_REF_TYPE" != "tag" ]; then');
    expect(RELEASE_WORKFLOW).toContain('[ "${{ inputs.publish }}" = "true" ]; then');
    expect(RELEASE_WORKFLOW).toContain('if [ "${{ inputs.check_only }}" = "true" ]; then');
    expect(RELEASE_WORKFLOW).toContain("mode=promote");
    expect(RELEASE_WORKFLOW).toContain('mode=dry-run');
    expect(RELEASE_WORKFLOW).toContain('source_sha="$GITHUB_SHA"');
    expect(RELEASE_WORKFLOW).toContain("if: needs.gate.outputs.mode == 'promote'");
    expect(RELEASE_WORKFLOW).toContain('release_tag:');
    expect(RELEASE_WORKFLOW).toContain('release_tag="$GITHUB_REF_NAME"');
    expect(RELEASE_WORKFLOW).toContain('REQUESTED_RELEASE_TAG: ${{ inputs.release_tag }}');
    expect(RELEASE_WORKFLOW).toContain('release_tag="$REQUESTED_RELEASE_TAG"');
    expect(RELEASE_WORKFLOW).toContain('[[ ! "$release_tag" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+');
    expect(RELEASE_WORKFLOW).toContain('ref: refs/tags/${{ needs.gate.outputs.release_tag }}');
    expect(RELEASE_WORKFLOW).toContain('tag_sha=$(git rev-parse "refs/tags/${RELEASE_TAG}^{commit}")');
    expect(RELEASE_WORKFLOW).toContain('commits/${tag_sha}/pulls');
    expect(RELEASE_WORKFLOW).toContain('RELEASE_TAG: ${{ needs.gate.outputs.release_tag }}');
    expect(RELEASE_WORKFLOW).not.toContain('gh release upload "$GITHUB_REF_NAME"');
    expect(RELEASE_WORKFLOW).not.toContain('gh release view "$GITHUB_REF_NAME"');
    expect(RELEASE_WORKFLOW).not.toContain('gh release edit "$GITHUB_REF_NAME"');
    expect(RELEASE_WORKFLOW).toMatch(/npx electron-builder[^\n]*--publish never/);
    expect(RELEASE_WORKFLOW).not.toContain("require-green-test-run");
    expect(fs.readFileSync(path.join(WORKFLOWS, "pin-drift.yml"), "utf8")).toContain(
      'dispatch_and_confirm release-desktop.yml "Desktop release artifacts"',
    );
    const imageWorkflow = fs.readFileSync(path.join(WORKFLOWS, "publish-image.yml"), "utf8");
    expect(imageWorkflow).toContain("require-green-test-run");
  });

  it("validates and hands off every release artifact", () => {
    expect(RELEASE_WORKFLOW).toContain("node scripts/validate-release-pr.mjs --base");
    expect(RELEASE_WORKFLOW).toContain("release-artifact-manifest.mjs create");
    expect(RELEASE_WORKFLOW).toContain("release-artifact-manifest.mjs verify");
    expect(RELEASE_WORKFLOW).toContain("retention-days: 90");
    expect(RELEASE_WORKFLOW).toContain("name: Desktop release artifacts");
    expect(RELEASE_WORKFLOW).toContain("statuses: write");
    expect(RELEASE_WORKFLOW).toContain("/statuses/${TARGET_SHA}");
    expect(RELEASE_WORKFLOW).toContain("name: Promote prebuilt desktop artifacts");
    expect(RELEASE_WORKFLOW).toContain('gh release upload "$RELEASE_TAG" "$asset" --clobber');
    expect(RELEASE_WORKFLOW).toContain('.workflow_id == $workflow_id');
    expect(RELEASE_WORKFLOW).toContain('.event == "pull_request_target"');
    expect(RELEASE_WORKFLOW).toContain('.status == "completed"');
    expect(RELEASE_WORKFLOW).toContain('.conclusion == "success"');
    expect(RELEASE_WORKFLOW).toContain('.head_sha == $head_sha');
    expect(RELEASE_WORKFLOW).toContain('.head_branch == env.RELEASE_BRANCH');
    expect(RELEASE_WORKFLOW).not.toContain('.pull_requests');
    expect(RELEASE_WORKFLOW).toContain('.head.repo.full_name == env.GH_REPO');
    expect(RELEASE_WORKFLOW).toContain('git fetch --no-tags origin "refs/pull/${pr}/head"');
    expect(RELEASE_WORKFLOW).toContain('if [ "$fetched_head" != "$head_sha" ]; then');
    expect(RELEASE_WORKFLOW).toContain("':(exclude).github/**'");
    expect(RELEASE_WORKFLOW).toContain("':(exclude)CLAUDE.md'");
    expect(RELEASE_WORKFLOW).toContain("':(exclude)tests/**'");
    expect(RELEASE_WORKFLOW).toContain('git rev-parse "${head_sha}^{tree}"');
    expect(RELEASE_WORKFLOW).toMatch(/- name: Stage the release handoff[\s\S]*- name: Upload the release handoff/);
    expect(RELEASE_WORKFLOW).not.toContain("-name '*.yml'");
    expect(RELEASE_WORKFLOW).toContain("awk '!/\\/builder-debug\\.yml$/'");
    expect(RELEASE_WORKFLOW).toContain("declare -A upload_names=()");
    expect(RELEASE_WORKFLOW).toContain('for asset in "${assets[@]}"; do');
    expect(RELEASE_WORKFLOW).toContain('gh release upload "$RELEASE_TAG" "$asset" --clobber');
    expect(RELEASE_WORKFLOW).not.toContain('gh release upload "$RELEASE_TAG" "${assets[@]}" --clobber');
    for (const pattern of ["latest*.yml", "*.blockmap", "*.dmg", "*.zip", "*.deb", "*.AppImage", "*.exe"]) {
      expect(RELEASE_WORKFLOW).toContain(`-name '${pattern}'`);
    }
  });

  it("caches electron-builder downloads and retries transient HTTP failures once", () => {
    expect(RELEASE_WORKFLOW).toContain(
      "ELECTRON_BUILDER_CACHE: ${{ runner.temp }}/electron-builder-cache",
    );
    expect(RELEASE_WORKFLOW).toContain(
      "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0",
    );
    expect(RELEASE_WORKFLOW).toContain("path: ${{ runner.temp }}/electron-builder-cache");
    expect(RELEASE_WORKFLOW).toContain(
      "key: electron-builder-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('desktop/package-lock.json') }}",
    );
    expect(RELEASE_WORKFLOW).toContain("DEBUG: electron-builder*,@electron/get*");
    expect(RELEASE_WORKFLOW).toContain("for attempt in 1 2; do");
    expect(RELEASE_WORKFLOW).toContain(
      'log="$RUNNER_TEMP/electron-builder-attempt-${attempt}.log"',
    );
    expect(RELEASE_WORKFLOW).toContain('status=${PIPESTATUS[0]}');
    expect(RELEASE_WORKFLOW).toContain(
      "grep -Eq 'HTTPError: Response code (500|502|503|504)' \"$log\"",
    );
    expect(RELEASE_WORKFLOW).toContain('rm -rf dist');
    expect(RELEASE_WORKFLOW).not.toContain('rm -rf desktop/dist');
    expect(RELEASE_WORKFLOW).not.toContain('rm -rf .');
  });
});

describe("required release checks", () => {
  it("requires the desktop artifact aggregate", () => {
    const rules = readJson(".github", "rulesets", "required-checks.json") as {
      parameters: { required_status_checks: Array<{ context: string }> };
    };
    expect(rules.parameters.required_status_checks.map(({ context }) => context)).toContain(
      "Desktop release artifacts",
    );
  });
});
