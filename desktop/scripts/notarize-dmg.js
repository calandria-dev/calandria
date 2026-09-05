"use strict";

// electron-builder's `artifactBuildCompleted` hook: notarizes and staples the
// .dmg. electron-builder's own notarization, inside `MacPackager.sign()`,
// signs and staples only the .app; a .dmg is its own notarizable container,
// and stapling it lets Gatekeeper clear it without a network round trip.
//
// The .zip is left un-stapled: there is nowhere to staple a ticket to a zip,
// and the .app inside it is already stapled, which is what Squirrel.Mac
// needs to extract and validate an update.
//
// Runs on `artifactBuildCompleted`, ahead of `afterAllArtifactBuild`.
// `PublishManager` schedules an upload off the earlier `artifactCreated`
// event, so notarizing here keeps a `--publish` run from uploading the
// unstapled bytes.
//
// `DmgTarget.build()` computes the .dmg's blockmap and sha512 before this
// hook runs, so both describe the pre-staple file. `electron-updater` updates
// via the .zip on macOS, never the .dmg, so that mismatch has no effect.

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

  // Already validated by macSigning(): it throws instead of returning
  // notarize: true with nothing to notarize with.
  const credentials = notarizeCredentials(env);

  // Loaded lazily so a Linux or Windows build, which never reaches this
  // line, does not need the dependency resolved.
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
