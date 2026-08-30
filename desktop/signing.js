"use strict";

// Where the signing POLICY lives, separately from electron-builder.cjs, which
// only assembles a config object out of it.
//
// Everything here is a pure function of an environment, for two reasons. It is
// the only part of macOS and Windows signing that can be tested on a Linux
// machine with no certificate — tests/desktopSigning.test.ts drives every
// branch — and the branches themselves are the whole hazard. A build that
// quietly falls back to "unsigned" is indistinguishable from a successful one
// until a user downloads it, so the rule throughout is: signing is OFF unless
// asked for, and a HALF-CONFIGURED request is an error rather than a downgrade.
//
// The knobs are build-time environment, not app configuration, so they are not
// in lib/config.ts or .env.example — nothing in the running app reads them.
// docs/DESKTOP_APP.md §7 and desktop/README.md document them.

/** Non-empty, whitespace-trimmed, or undefined. */
function read(env, name) {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The notarization credentials electron-builder's own notarytool path reads,
 * detected the same way it detects them (MacTargetHelper.getNotarizeOptions):
 * three mutually exclusive groups, and a partially-filled group is an error
 * rather than a fall-through to the next one.
 *
 * We re-derive this rather than leaving it to electron-builder because
 * electron-builder's version of "no credentials" is a WARNING and a skip. On a
 * release run that means shipping an un-notarized .dmg behind a green build,
 * which is the exact failure this task exists to prevent. `macSigning()` turns
 * it into a thrown error before packaging starts.
 *
 * Returns null when nothing at all is set, or throws when one group is started
 * and not finished. The App Store Connect API key is preferred over an
 * app-specific password: it is revocable on its own and is not the account
 * password.
 */
function notarizeCredentials(env) {
  const appleId = read(env, "APPLE_ID");
  const appleIdPassword = read(env, "APPLE_APP_SPECIFIC_PASSWORD");
  const teamId = read(env, "APPLE_TEAM_ID");

  const apiKey = read(env, "APPLE_API_KEY");
  const apiKeyId = read(env, "APPLE_API_KEY_ID");
  const apiIssuer = read(env, "APPLE_API_ISSUER");

  const keychain = read(env, "APPLE_KEYCHAIN");
  const keychainProfile = read(env, "APPLE_KEYCHAIN_PROFILE");

  // Checked before the Apple-ID group so that a stray APPLE_TEAM_ID — which is
  // useful on its own and which people set out of habit — does not read as a
  // half-finished password login when an API key is what was actually meant.
  if (apiKey || apiKeyId || apiIssuer) {
    const missing = [
      apiKey ? null : "APPLE_API_KEY",
      apiKeyId ? null : "APPLE_API_KEY_ID",
      apiIssuer ? null : "APPLE_API_ISSUER",
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(
        `Incomplete App Store Connect notarization credentials: ${missing.join(", ")} ` +
          `${missing.length === 1 ? "is" : "are"} not set. All three of APPLE_API_KEY (the .p8 path ` +
          `or its contents), APPLE_API_KEY_ID and APPLE_API_ISSUER are required together.`
      );
    }
    return { kind: "api-key", appleApiKey: apiKey, appleApiKeyId: apiKeyId, appleApiIssuer: apiIssuer };
  }

  if (appleId || appleIdPassword) {
    const missing = [
      appleId ? null : "APPLE_ID",
      appleIdPassword ? null : "APPLE_APP_SPECIFIC_PASSWORD",
      teamId ? null : "APPLE_TEAM_ID",
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(
        `Incomplete Apple ID notarization credentials: ${missing.join(", ")} ` +
          `${missing.length === 1 ? "is" : "are"} not set. Prefer an App Store Connect API key ` +
          `(APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER), which is revocable on its own.`
      );
    }
    return { kind: "apple-id", appleId, appleIdPassword, teamId };
  }

  if (keychainProfile) {
    return { kind: "keychain", keychain, keychainProfile };
  }

  return null;
}

/**
 * The macOS half. Returns the `mac` fields electron-builder.cjs spreads in, plus
 * a `signed` flag the rest of the build reads.
 *
 * `mac.identity: "-"` is electron-builder's ad-hoc path and it WINS over
 * CSC_LINK (macCodeSign.findIdentity takes the configured qualifier ahead of any
 * imported certificate), which is what makes the default safe: a CI lane that
 * does not opt in cannot sign with a real certificate even if one somehow
 * reached its environment. Opting in is a single explicit variable naming the
 * identity, never the mere presence of a secret.
 *
 * hardenedRuntime is on in BOTH branches. electron-builder's own default is
 * true and the previous config turned it off; leaving the ad-hoc build
 * un-hardened would mean the first bundle ever to run under hardened runtime is
 * the one nobody can test. The two entitlements files are where the branch
 * actually lives — see their comments.
 */
function macSigning(env) {
  const identity = read(env, "CALANDRIA_MAC_SIGN_IDENTITY");
  const skipNotarize = read(env, "CALANDRIA_MAC_SKIP_NOTARIZE") === "1";

  if (identity === undefined || identity === "-") {
    return {
      signed: false,
      notarize: false,
      identity: "-",
      hardenedRuntime: true,
      entitlements: "build/entitlements.mac.adhoc.plist",
      entitlementsInherit: "build/entitlements.mac.adhoc.plist",
    };
  }

  // Throws on a half-filled group; null means none was attempted at all.
  const credentials = notarizeCredentials(env);

  if (!credentials && !skipNotarize) {
    throw new Error(
      "CALANDRIA_MAC_SIGN_IDENTITY is set but no notarization credentials are. A Developer ID " +
        "signature without notarization is still refused by Gatekeeper on a downloaded copy, so " +
        "this build would look signed and behave unsigned. Set APPLE_API_KEY, APPLE_API_KEY_ID and " +
        "APPLE_API_ISSUER (an App Store Connect key), or set CALANDRIA_MAC_SKIP_NOTARIZE=1 if you " +
        "are deliberately testing signing on its own and will not publish the result."
    );
  }

  return {
    signed: true,
    // false, not "skipped": electron-builder's own notarize path warns and
    // continues when it finds no credentials, and the guard above has already
    // decided this question with an error instead.
    notarize: Boolean(credentials) && !skipNotarize,
    identity,
    hardenedRuntime: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
  };
}

/**
 * The Windows half: Azure Artifact Signing (the service formerly called Azure
 * Trusted Signing), which electron-builder drives through `win.azureSignOptions`.
 *
 * There is no certificate and no secret to store. Authentication is Microsoft
 * Entra ID's ambient credential chain, which on GitHub Actions is OIDC
 * workload-identity federation — AZURE_CLIENT_ID, AZURE_TENANT_ID and the token
 * file the `azure/login` action writes. electron-builder reads none of those
 * itself; the Azure signing library does. So the four variables below are the
 * only ones this file knows about, and none of them is secret.
 *
 * All four or none. Three of four is a build that packages green and produces an
 * unsigned installer.
 */
function windowsSigning(env) {
  const fields = {
    endpoint: read(env, "AZURE_CODE_SIGNING_ENDPOINT"),
    codeSigningAccountName: read(env, "AZURE_CODE_SIGNING_ACCOUNT_NAME"),
    certificateProfileName: read(env, "AZURE_CODE_SIGNING_CERT_PROFILE_NAME"),
    publisherName: read(env, "AZURE_CODE_SIGNING_PUBLISHER_NAME"),
  };

  const names = {
    endpoint: "AZURE_CODE_SIGNING_ENDPOINT",
    codeSigningAccountName: "AZURE_CODE_SIGNING_ACCOUNT_NAME",
    certificateProfileName: "AZURE_CODE_SIGNING_CERT_PROFILE_NAME",
    publisherName: "AZURE_CODE_SIGNING_PUBLISHER_NAME",
  };

  const set = Object.keys(fields).filter((key) => fields[key] !== undefined);
  if (set.length === 0) return { signed: false };

  const missing = Object.keys(fields)
    .filter((key) => fields[key] === undefined)
    .map((key) => names[key]);
  if (missing.length) {
    throw new Error(
      `Incomplete Azure Artifact Signing configuration: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set. All four of ${Object.values(names).join(", ")} ` +
        `are required together; a partial set would package a green, unsigned installer.`
    );
  }

  return { signed: true, azureSignOptions: fields };
}

module.exports = { notarizeCredentials, macSigning, windowsSigning };
