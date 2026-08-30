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
  files: ["main.js", "supervisor.js", "notifier.js", "tray-residency.js", "loading.html", "assets/**", "package.json"],
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
  // Inert outside a release. Nothing publishes without `--publish always` or a
  // tag plus a token, and no lane in test.yml has either.
  publish: [
    {
      provider: "github",
      owner: "calandria-dev",
      repo: "calandria",
    },
  ],

  // Fires once per finished artifact and is awaited BEFORE the artifact is
  // announced to the publisher, which is the whole reason it is this hook and
  // not `afterAllArtifactBuild` — see the header of the module it calls. A
  // no-op for anything that is not a .dmg, and for any build that is not both
  // signed and notarizing.
  artifactBuildCompleted: (event) => require("./scripts/notarize-dmg").notarizeDmgArtifact(event),
};
