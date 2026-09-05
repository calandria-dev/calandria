"use strict";

// The electron-builder configuration, moved out of desktop/package.json's
// `build` field because signing has to be a decision made at build time and
// JSON cannot make one.
//
// The move is all-or-nothing: app-builder-lib's config loader
// (out/util/config/load.js, `loadConfig`) reads package.json's `build` field
// first and only falls back to scanning for a standalone config file when
// that field is absent. It does not merge them and does not warn. A `build`
// field in package.json would shadow this entire file, including every
// signing branch below, with no error.
//
// The filename is likewise fixed: the loader probes `electron-builder` +
// {.yml,.yaml,.json,.json5,.toml,.js,.cjs,.ts}, in that order.
// `electron-builder.cjs` is on that list; `electron-builder.config.cjs`, the
// name most projects use, is not, and would be ignored with no error either.
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
  // Source files only. `node_modules` is absent on purpose, and adding it
  // would do nothing: app-builder-lib collects production dependencies through
  // a separate mechanism (`getNodeModuleFileMatcher` +
  // `computeNodeModuleFileSets`, out/platformPackager.js) and splices
  // `!**/node_modules/**` into these globs unconditionally
  // (out/fileMatcher.js). So `electron-updater`, this package's one runtime
  // dependency, is packed because it is in `dependencies`, not because it is
  // named here, and it must not be moved to `devDependencies`.
  // An explicit whitelist: a new module supervisor.js requires has to be
  // added here too, or the packaged app dies on the require with a stack that
  // does not reproduce from a checkout, since `npm start` resolves it from
  // disk either way. desktop/test-supervisor.js pins this list against
  // exactly that.
  files: [
    "main.js",
    "supervisor.js",
    "env-file.js",
    "instances.js",
    "instances.html",
    "notifier.js",
    "ssh-tunnel.js",
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
    // `notarize` are all decided by desktop/signing.js from the environment.
    // With nothing set: ad-hoc identity "-", hardened runtime on, the ad-hoc
    // entitlements, no notarization. Opt in with CALANDRIA_MAC_SIGN_IDENTITY
    // plus App Store Connect credentials.
    identity: mac.identity,
    hardenedRuntime: mac.hardenedRuntime,
    entitlements: mac.entitlements,
    entitlementsInherit: mac.entitlementsInherit,
    notarize: mac.notarize,
  },

  // Only the AppImage self-updates; the .deb does not.
  //
  // Because a `publish` config is present, electron-builder's FpmTarget writes
  // a `resources/package-type` marker containing "deb" into the .deb (it does
  // this for deb, rpm and pacman; the AppImage gets no marker). electron-updater
  // reads that marker the first time anything touches its exported `autoUpdater`
  // and, on finding it, returns a DebUpdater whose install path is
  // `sudo dpkg -i <downloaded .deb>`, falling back to
  // `apt install --allow-unauthenticated`. No setting turns the
  // unverified-package install off (`allowUnverifiedLinuxPackages` was checked
  // against electron-builder 26.15.3 and electron-updater 6.8.9 and exists in
  // neither), so the only way to avoid that path is to not be on it.
  //
  // desktop/updater.js gates on `process.env.APPIMAGE` before the require, and
  // a .deb install says so in its menus instead of raising a sudo prompt the
  // user has no reason to trust. Removing that gate would opt every .deb user
  // into it with no warning.
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
    // Absent unless all four AZURE_CODE_SIGNING_* variables are set. When
    // present, it switches electron-builder from signtool to Azure Artifact
    // Signing (winPackager.js picks WindowsSignAzureManager on
    // `azureSignOptions != null`).
    ...(win.signed ? { azureSignOptions: win.azureSignOptions } : {}),
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },

  // Controls where a release's artifacts go, and, easy to miss, where the
  // update feed comes from. With a `github` provider configured,
  // electron-builder's PublishManager both attaches each artifact to the
  // Release and writes the per-platform feed beside it: latest.yml,
  // latest-mac.yml, latest-linux.yml, plus the .blockmap files
  // electron-updater uses for differential downloads. Building locally and
  // uploading with `gh release upload` produces the artifacts and none of
  // the feed, so the updater never finds anything.
  //
  // owner/repo are spelled out instead of inferred. electron-builder would
  // otherwise fall back to parsing package.json's `repository` field, which
  // this package does not have, and then to the CI environment: a chain
  // whose failure mode is publishing into the wrong place with no error.
  //
  // The tag is derived from `version` in package.json, not from the ref
  // being built, which is why release-please-config.json's `extra-files`
  // keeps desktop/package.json in step with the root manifest: a desktop
  // package reading a stale version during a release would mint a draft
  // release under the wrong tag instead of failing outright.
  // .github/workflows/release-desktop.yml checks the two agree before it
  // builds.
  //
  // `releaseType: "release"` matters because electron-publish's
  // GitHubPublisher otherwise defaults it to "draft"
  // (out/gitHubPublisher.js: `this.releaseType = options.draft === false ?
  // "release" : "draft"`), while release-please has already created a
  // published release for the tag by the time this workflow runs. The
  // publisher refuses to write into a release whose type does not match what
  // it is publishing, logs one warning per skipped artifact, and exits 0:
  // every artifact and every update feed is skipped and the lane goes green
  // having uploaded nothing. Declaring the type we are actually publishing
  // into makes the publisher adopt the existing release instead
  // (`getOrCreateRelease` only takes the refuse branch when releaseType is
  // "draft").
  //
  // Because "log a warning and continue" is this publisher's normal
  // behavior, the workflow asserts the assets actually landed instead of
  // trusting the exit code. The same function also refuses a release
  // published more than two hours ago, which a slow notarization or a
  // re-run can cross; EP_GH_IGNORE_TIME=true in
  // .github/workflows/release-desktop.yml turns that second refusal off. It
  // is set there, not here, because it is only correct for a lane whose
  // release was minted minutes earlier by release-please.
  //
  // This config is not inert outside a release, either. With no `--publish`
  // flag, PublishManager decides a policy itself: `always` when
  // npm_lifecycle_event is "release", `onTag` when a CI tag is visible, and
  // on any CI at all, `onTagOrDraft`, which still has to ask GitHub whether
  // a draft release is waiting. So `npx electron-builder --win nsis` on a
  // hosted runner constructs a GitHubPublisher, whose constructor throws for
  // lack of a token before it looks at anything else. Hence `--publish
  // never` on every invocation outside .github/workflows/release-desktop.yml,
  // pinned by tests/desktopRelease.test.ts. A `dir`-only lane survives
  // without the flag only because `dir` announces no artifact to publish,
  // which stops being true the moment a real target is added to that lane.
  publish: [
    {
      provider: "github",
      owner: "calandria-dev",
      repo: "calandria",
      releaseType: "release",
    },
  ],

  // Fires once per finished artifact and is awaited before the artifact is
  // announced to the publisher; see the header of the module it calls for
  // why that ordering is why this hook is used instead of
  // `afterAllArtifactBuild`. A no-op for anything that is not a .dmg, and
  // for any build that is not both signed and notarizing.
  artifactBuildCompleted: (event) => require("./scripts/notarize-dmg").notarizeDmgArtifact(event),
};
