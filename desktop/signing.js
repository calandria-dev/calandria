"use strict";

// Signing policy, separate from electron-builder.cjs, which only assembles a
// config object out of it.
//
// Everything here is a pure function of an environment, so it can be tested
// without a certificate (tests/desktopSigning.test.ts drives every branch).
// A build that falls back to "unsigned" looks identical to a signed one
// until a user downloads it, so signing is OFF unless asked for, and a
// half-configured request fails instead of falling back.
//
// These are build-time environment variables, not app configuration: they
// are not in lib/config.ts or .env.example, and nothing in the running app
// reads them.

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
 * three mutually exclusive groups. A partially filled group is an error.
 *
 * This is re-derived here because electron-builder treats missing
 * credentials as a warning and skips notarizing, which would ship an
 * un-notarized .dmg behind a green build. `macSigning()` turns that into a
 * thrown error before packaging starts.
 *
 * Returns null when nothing is set, or throws when one group is started and
 * not finished. The App Store Connect API key is preferred over an
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

  // Checked before the Apple-ID group so a stray APPLE_TEAM_ID (useful on its
  // own, and often set out of habit) does not read as a half-finished
  // password login when an API key was meant.
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

// Certificate types electron-builder refuses to see in `mac.identity`, copied
// from app-builder-lib's `appleCertificatePrefixes`
// (out/codeSign/macCodeSign.js).
const APPLE_CERTIFICATE_PREFIXES = [
  "Developer ID Application:",
  "Developer ID Installer:",
  "3rd Party Mac Developer Application:",
  "3rd Party Mac Developer Installer:",
];

/**
 * `mac.identity` must be a QUALIFIER, not a certificate name.
 *
 * The full certificate name is what a human is told to store: the
 * certificate's own CN reads that way, and verify-signing-credentials.yml
 * greps `security find-identity` output for it. But app-builder-lib's
 * `findIdentity` runs every configured qualifier through `checkPrefix`
 * against the list above and throws on a match, so the full name has to be
 * stripped before use.
 *
 * The strip happens here, once, instead of in the stored secret, so the
 * value in storage still matches what `openssl x509 -noout -subject` prints
 * and what the credential check greps for.
 *
 * Stripping is safe because the qualifier is matched as a SUBSTRING of the
 * `find-identity` line (`_findIdentity`: `line.includes(qualifier)`), and the
 * type is matched separately on the same line, so "Example (AB12CD34EF)"
 * selects exactly "Developer ID Application: Example (AB12CD34EF)" and
 * nothing else. A bare type with no name after it is refused instead of
 * passed on as "", which electron-builder reads as nothing configured and
 * answers with keychain auto-discovery.
 */
function certificateQualifier(identity) {
  for (const prefix of APPLE_CERTIFICATE_PREFIXES) {
    if (!identity.startsWith(prefix)) continue;
    const qualifier = identity.slice(prefix.length).trim();
    if (qualifier === "") {
      throw new Error(
        `CALANDRIA_MAC_SIGN_IDENTITY is "${identity}", a certificate type with no name after it. Set it to ` +
          'the full certificate name, e.g. "Developer ID Application: Example (AB12CD34EF)" — the CN that ' +
          "`security find-identity -v -p codesigning` prints."
      );
    }
    return qualifier;
  }
  return identity;
}

/**
 * The macOS half. Returns the `mac` fields electron-builder.cjs spreads in,
 * plus a `signed` flag the rest of the build reads.
 *
 * `mac.identity: "-"` is electron-builder's ad-hoc path and wins over
 * CSC_LINK (macCodeSign.findIdentity takes the configured qualifier ahead of
 * any imported certificate), so a CI lane that does not opt in cannot sign
 * with a real certificate even if one reached its environment. Opting in
 * requires a single explicit variable naming the identity, never just the
 * presence of a secret.
 *
 * hardenedRuntime is on in both branches, so the ad-hoc build is exercised
 * under the same hardened runtime as a real release. The two entitlements
 * files carry the actual difference between the branches; see their
 * comments.
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

  // Runs before the credential check so a malformed identity is caught
  // first.
  const qualifier = certificateQualifier(identity);

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
    // electron-builder's own notarize path warns and continues on missing
    // credentials; the guard above already turned that case into an error.
    notarize: Boolean(credentials) && !skipNotarize,
    identity: qualifier,
    hardenedRuntime: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
  };
}

/**
 * The Windows half: Azure Artifact Signing, driven through
 * `win.azureSignOptions`.
 *
 * There is no certificate and no secret to store. Authentication is
 * Microsoft Entra ID's ambient credential chain, which on GitHub Actions is
 * OIDC workload-identity federation: AZURE_CLIENT_ID, AZURE_TENANT_ID and
 * the token file the `azure/login` action writes. electron-builder reads
 * none of those itself; the Azure signing library does. The four variables
 * below are the only ones this file knows about, and none of them is
 * secret.
 *
 * All four or none: three of four packages a green build with an unsigned
 * installer.
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
