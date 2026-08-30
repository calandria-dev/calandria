"use strict";

// electron-builder's `artifactBuildCompleted` hook: notarize and staple the
// .dmg, which nothing else does.
//
// WHY THIS EXISTS AT ALL, since electron-builder already notarizes.
// electron-builder's built-in notarization runs inside MacPackager.sign(), on
// the .app, and @electron/notarize staples the ticket to that bundle before
// returning. `sign()` is awaited before `packageInDistributableFormat()`, so the
// .dmg and the .zip are both cut from an already-stapled bundle — which is
// exactly the ordering we need and is why the ad-hoc signature had to move into
// the build in the first place (docs/DESKTOP_APP.md §6.2).
//
// What that does NOT cover is the disk image itself. A .dmg is its own
// notarizable container, and it is the thing the browser tags with
// com.apple.quarantine. Apple's guidance is to submit what you distribute; here
// that is the image, and stapling a ticket to it is what lets Gatekeeper clear
// it without a network round trip on a machine that has never seen it.
//
// The .zip is deliberately left alone. Ticket stapling has no meaning for a zip
// — there is nowhere to put the ticket — and the app inside it is already
// stapled, which is what Squirrel.Mac needs when it extracts and validates an
// update.
//
// WHY `artifactBuildCompleted` AND NOT `afterAllArtifactBuild`, which is the
// obvious hook and the one most projects reach for. `PublishManager` schedules
// an upload from the `artifactCreated` event, and `Packager.emitArtifactBuildCompleted`
// awaits this hook and THEN emits it. `afterAllArtifactBuild` runs after
// `packager.build()` resolves, by which point a `--publish` run has already
// started sending the un-stapled bytes. The two hooks differ by a race that only
// shows up in the release lane and only as a download that warns.
//
// KNOWN AND ACCEPTED: `DmgTarget.build()` computes the .dmg's blockmap and
// sha512 immediately before this hook runs, so both describe the pre-staple
// file. That is inert here — `electron-updater` uses the .zip on macOS, never
// the .dmg — but it is why the dmg's entry in `latest-mac.yml` must not become
// load-bearing for updates.

const path = require("node:path");

const { macSigning, notarizeCredentials } = require("../signing");

/**
 * @param {{ file?: string }} event electron-builder's ArtifactCreated
 * @param {Record<string, string | undefined>} [env]
 */
async function notarizeDmgArtifact(event, env = process.env) {
  const file = event && event.file;
  if (typeof file !== "string" || !file.toLowerCase().endsWith(".dmg")) return;

  const mac = macSigning(env);
  if (!mac.signed || !mac.notarize) return;

  // Already validated by macSigning() — it throws rather than returning
  // notarize: true with nothing to notarize with.
  const credentials = notarizeCredentials(env);

  // Loaded here rather than at module scope so that a Linux or Windows build,
  // which never reaches this line, does not need the dependency resolved.
  const { notarize } = require("@electron/notarize");

  console.log(`notarizing ${path.basename(file)} (a round trip to Apple; allow several minutes)`);
  await notarize({ tool: "notarytool", appPath: file, ...toNotarizeOptions(credentials) });
  console.log(`stapled ${path.basename(file)}`);
}

/** Our credential shape → @electron/notarize's. */
function toNotarizeOptions(credentials) {
  switch (credentials.kind) {
    case "api-key":
      return {
        appleApiKey: credentials.appleApiKey,
        appleApiKeyId: credentials.appleApiKeyId,
        appleApiIssuer: credentials.appleApiIssuer,
      };
    case "apple-id":
      return {
        appleId: credentials.appleId,
        appleIdPassword: credentials.appleIdPassword,
        teamId: credentials.teamId,
      };
    case "keychain":
      return { keychain: credentials.keychain, keychainProfile: credentials.keychainProfile };
    default:
      throw new Error(`unknown notarization credential kind: ${credentials.kind}`);
  }
}

module.exports = { notarizeDmgArtifact, toNotarizeOptions };
