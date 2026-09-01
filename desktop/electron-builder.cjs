"use strict";

// The electron-builder configuration, moved out of desktop/package.json's
// `build` field because signing has to be a decision made at build time and JSON
// cannot make one.
//
// THE MOVE IS ALL-OR-NOTHING, which is worth knowing before anyone puts a
// `build` key back. app-builder-lib's config loader (out/util/config/load.js,
// `loadConfig`) reads package.json's `build` field FIRST and only falls back to
// scanning for a standalone config file when that field is absent. It does not
// merge them and it does not warn. A `build` field in package.json would
// silently shadow this entire file, including every signing branch below.
//
// The filename is likewise not free: the loader probes `electron-builder` +
// {.yml,.yaml,.json,.json5,.toml,.js,.cjs,.ts}, in that order. `electron-builder.cjs`
// is on that list; `electron-builder.config.cjs`, the name most projects use,
// is not, and would be ignored just as quietly.
//
// Everything that is not signing is unchanged from the JSON it replaces.

const { macSigning, windowsSigning } = require("./signing");

const mac = macSigning(process.env);
const win = windowsSigning(process.env);

module.exports = {
  appId: "dev.calandria.desktop",
  productName: "Calandria",
  copyright: "Copyright © Calandria contributors",
  directories: {
    output: "dist",
  },
  // Source files only. `node_modules` is deliberately absent and adding it
  // would do nothing: app-builder-lib collects production dependencies through
  // a separate mechanism (`getNodeModuleFileMatcher` +
  // `computeNodeModuleFileSets`, out/platformPackager.js) and splices
  // `!**/node_modules/**` into these globs unconditionally
  // (out/fileMatcher.js). So `electron-updater`, this package's one runtime
  // dependency, is packed because it is in `dependencies` — not because it is
  // named here, and it must not be moved to `devDependencies`.
  // An explicit whitelist, so a new module supervisor.js requires has to be
  // added HERE too or the packaged app dies on the require with a stack nobody
  // can reproduce from a checkout — `npm start` resolves it from disk either
  // way. desktop/test-supervisor.js pins this list against exactly that.
  files: [
    "main.js",
    "supervisor.js",
    "env-file.js",
    "notifier.js",
    "tray-residency.js",
    "updater.js",
    "loading.html",
    "assets/**",
    "package.json",
  ],
  extraResources: [
    { from: "payload", to: "app-payload" },
    { from: "payload/node_modules", to: "app-payload/node_modules" },
    { from: "vendor/node", to: "node" },
  ],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,

  mac: {
    target: ["dir", "dmg", "zip"],
    category: "public.app-category.developer-tools",
    icon: "../public/icons/icon-512.png",
    gatekeeperAssess: false,

    // `identity`, `hardenedRuntime`, `entitlements`, `entitlementsInherit` and
    // `notarize`, all decided by desktop/signing.js from the environment.
    // Default (nothing set): ad-hoc identity "-", hardened runtime on, the
    // ad-hoc entitlements, no notarization. Opt in with
    // CALANDRIA_MAC_SIGN_IDENTITY plus App Store Connect credentials.
    identity: mac.identity,
    hardenedRuntime: mac.hardenedRuntime,
    entitlements: mac.entitlements,
    entitlementsInherit: mac.entitlementsInherit,
    notarize: mac.notarize,
  },

  // ONLY THE AppImage SELF-UPDATES, and that is a decision, not an omission.
  //
  // Because a `publish` config is present, electron-builder's FpmTarget writes a
  // `resources/package-type` marker containing "deb" into the .deb (it does this
  // for deb, rpm and pacman; the AppImage gets no marker). electron-updater
  // reads that marker the first time anything touches its exported `autoUpdater`
  // and, on finding it, returns a DebUpdater whose install path is
  // `sudo dpkg -i <downloaded .deb>`, falling back to
  // `apt install --allow-unauthenticated`. There is no setting that turns the
  // unverified-package install off — `allowUnverifiedLinuxPackages` was checked
  // against electron-builder 26.15.3 and electron-updater 6.8.9 and exists in
  // neither — so "make it deliberate" can only mean declining to be on that path.
  //
  // desktop/updater.js therefore gates on `process.env.APPIMAGE` BEFORE the
  // require, and a .deb install says so in its menus instead of raising a sudo
  // prompt the user has no reason to trust. Removing that gate is what would
  // silently opt every .deb user into it.
  linux: {
    target: ["dir", "deb", "AppImage"],
    executableName: "calandria-desktop",
    category: "Development",
    synopsis: "Run many Claude Code and Codex sessions in parallel, locally",
    maintainer: "Calandria contributors <calandria@example.invalid>",
    icon: "../public/icons/icon-512.png",
    syncDesktopName: true,
  },

  win: {
    target: ["nsis", "zip"],
    icon: "../public/icons/icon-512.png",
    // Absent unless all four AZURE_CODE_SIGNING_* variables are set. Present, it
    // switches electron-builder from signtool to Azure Artifact Signing
    // (winPackager.js picks WindowsSignAzureManager on `azureSignOptions != null`).
    ...(win.signed ? { azureSignOptions: win.azureSignOptions } : {}),
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },

  // WHERE A RELEASE'S ARTIFACTS GO, and — the half that is easy to miss — where
  // the UPDATE FEED comes from. With a `github` provider configured,
  // electron-builder's PublishManager both attaches each artifact to the Release
  // and writes the per-platform feed beside it: latest.yml, latest-mac.yml,
  // latest-linux.yml, plus the .blockmap files electron-updater uses for
  // differential downloads. Building locally and uploading with
  // `gh release upload` produces the artifacts and none of the feed, which is an
  // updater that silently never finds anything.
  //
  // owner/repo are spelled out rather than inferred. electron-builder would fall
  // back to parsing package.json's `repository` field, which this package does
  // not have, and then to the CI environment — a chain whose failure mode is
  // publishing into the wrong place rather than an error.
  //
  // THE TAG IS DERIVED FROM `version` IN package.json, not from the ref being
  // built. That is why release-please-config.json's `extra-files` keeps
  // desktop/package.json in step with the root manifest: a desktop package still
  // reading 0.3.0 during a v0.4.2 release would not fail, it would quietly mint a
  // DRAFT release named v0.3.0 and upload everything into that instead.
  // .github/workflows/release-desktop.yml checks the two agree before it builds.
  //
  // `releaseType: "release"` IS LOAD-BEARING, and its absence is why every
  // release from v0.2.0 to v0.5.1 has zero assets attached.
  //
  // electron-publish's GitHubPublisher defaults this to "draft"
  // (out/gitHubPublisher.js: `this.releaseType = options.draft === false ?
  // "release" : "draft"`). release-please has already created a PUBLISHED
  // release for the tag by the time this workflow starts, and the publisher
  // refuses to write into a release whose type does not match what it is
  // publishing:
  //
  //   • GitHub release not created  reason=existing type not compatible with
  //     publishing type  tag=v0.5.1 existingType=release publishingType=draft
  //   • skipped publishing  file=Calandria-Setup-0.5.1.exe  reason=…
  //   • skipped publishing  file=latest.yml                 reason=…
  //
  // It then EXITS 0. Every artifact and every update feed is skipped, one
  // warning apiece, and the lane goes green having uploaded nothing — which is
  // how this survived six releases unnoticed. Declaring the type we are actually
  // publishing into makes the publisher adopt the existing release instead
  // (`getOrCreateRelease` only takes the refuse branch when releaseType is
  // "draft").
  //
  // The workflow asserts the assets really landed rather than trusting the exit
  // code, because "logs a warning and continues" is this publisher's house
  // style: the same function ALSO refuses a release published more than two
  // hours ago, which a slow notarization or a re-run of one leg will cross.
  // EP_GH_IGNORE_TIME=true in .github/workflows/release-desktop.yml is that
  // second refusal turned off, and it is set there rather than here because it
  // is only correct for a lane whose release was minted minutes earlier by
  // release-please.
  //
  // NOT INERT OUTSIDE A RELEASE EITHER, and assuming it was is what turned main's
  // Windows desktop lane permanently red between v0.4.x and v0.5.0. The
  // superseded claim here — "nothing publishes without `--publish always` or a
  // tag plus a token" — is not how electron-builder decides. With no `--publish`
  // flag, PublishManager fills the policy in itself: `always` when
  // npm_lifecycle_event is "release", `onTag` when a CI tag is visible, and
  // otherwise, ON ANY CI AT ALL, `onTagOrDraft` — which is a publishing policy,
  // because it still has to ask GitHub whether a draft release is waiting. So
  // `npx electron-builder --win nsis` on a hosted runner constructs a
  // GitHubPublisher, and that constructor throws before it looks at anything:
  //
  //   Error: GitHub Personal Access Token is not set, neither programmatically,
  //   nor using env "GH_TOKEN"
  //
  // The one thing that did suppress it is an accident of the event. electron-
  // publish's isPullRequest() counts a non-empty GITHUB_BASE_REF, which only a
  // `pull_request` run has, and skips the whole publish path for it. Every
  // desktop lane is label-gated, so on a PR it either did not run or ran with
  // publishing disabled for free; the first push to main that packaged a real
  // target found the policy with nothing to suppress it. That is also why the
  // macOS lane is exposed rather than lucky: it `unset GITHUB_BASE_REF`s to
  // re-enable ad-hoc signing, which re-enables this at the same time.
  //
  // Hence `--publish never` on EVERY invocation outside .github/workflows/
  // release-desktop.yml, pinned by tests/desktopRelease.test.ts. The flag is the
  // only load-bearing part; a `dir`-only lane survives without it merely because
  // `dir` announces no artifact to publish, which stops being true the moment
  // anyone adds a real target to that lane.
  publish: [
    {
      provider: "github",
      owner: "calandria-dev",
      repo: "calandria",
      releaseType: "release",
    },
  ],

  // Fires once per finished artifact and is awaited BEFORE the artifact is
  // announced to the publisher, which is the whole reason it is this hook and
  // not `afterAllArtifactBuild` — see the header of the module it calls. A
  // no-op for anything that is not a .dmg, and for any build that is not both
  // signed and notarizing.
  artifactBuildCompleted: (event) => require("./scripts/notarize-dmg").notarizeDmgArtifact(event),
};
