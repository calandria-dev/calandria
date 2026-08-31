// The desktop signing policy, which is otherwise untestable anywhere the app is
// developed: it decides what a macOS or Windows installer gets signed with, and
// neither branch can be exercised without a Mac, a Windows box and two paid
// identities. What CAN be checked on any machine is the decision itself, and the
// decision is where the danger is — every failure mode here produces a build
// that goes green and ships an artifact the user's OS refuses.
//
// Four things are pinned:
//   1. Nothing set → ad-hoc, never a real identity. Signing is opt-in by name.
//   2. A half-configured request throws instead of quietly downgrading.
//   3. The two entitlements files differ in exactly one key, and it is the one
//      that must not reach a Developer ID build.
//   4. desktop/package.json carries no `build` field, because one would shadow
//      desktop/electron-builder.cjs — silently, and with it every rule above.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const DESKTOP = path.join(ROOT, "desktop");

// Same trick as tests/desktopPayload.test.ts: desktop/ has its own package tree
// (Electron is never installed in the app's), so these are loaded by absolute
// path rather than through "@/*" resolution. desktop/signing.js is deliberately
// dependency-free CommonJS for exactly this reason.
const require = createRequire(import.meta.url);

type Env = Record<string, string | undefined>;

type MacSigning = {
  signed: boolean;
  notarize: boolean;
  identity: string;
  hardenedRuntime: boolean;
  entitlements: string;
  entitlementsInherit: string;
};
type WindowsSigning = { signed: boolean; azureSignOptions?: Record<string, string> };

const signing = require(path.join(DESKTOP, "signing.js")) as {
  macSigning: (env: Env) => MacSigning;
  windowsSigning: (env: Env) => WindowsSigning;
  notarizeCredentials: (env: Env) => { kind: string } | null;
};
const { macSigning, windowsSigning, notarizeCredentials } = signing;

const IDENTITY = "Developer ID Application: Example (AB12CD34EF)";
// What electron-builder must be handed instead — see `certificateQualifier`.
const QUALIFIER = "Example (AB12CD34EF)";
const API_KEY = {
  APPLE_API_KEY: "/tmp/AuthKey_T9GPZ92M7K.p8",
  APPLE_API_KEY_ID: "T9GPZ92M7K",
  APPLE_API_ISSUER: "57246542-96fe-1a63-e053-0824d011072a",
};
const AZURE = {
  AZURE_CODE_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
  AZURE_CODE_SIGNING_ACCOUNT_NAME: "calandria",
  AZURE_CODE_SIGNING_CERT_PROFILE_NAME: "calandria-public-trust",
  AZURE_CODE_SIGNING_PUBLISHER_NAME: "CN=Example, O=Example, C=US",
};

describe("macOS signing policy", () => {
  it("signs ad-hoc when nothing is configured, and never picks up a stray certificate", () => {
    const mac = macSigning({});
    expect(mac.signed).toBe(false);
    expect(mac.notarize).toBe(false);
    expect(mac.identity).toBe("-");
    expect(mac.entitlements).toBe("build/entitlements.mac.adhoc.plist");
  });

  it("stays ad-hoc even with a certificate in the environment, because the identity decides", () => {
    // CSC_LINK is how electron-builder imports a .p12. macCodeSign.findIdentity
    // takes the configured qualifier ahead of anything in the keychain, so
    // identity "-" wins — which is what makes the test lane safe to run on a
    // pull request. Opting in is CALANDRIA_MAC_SIGN_IDENTITY, nothing else.
    const mac = macSigning({ CSC_LINK: "https://example.invalid/cert.p12", CSC_KEY_PASSWORD: "hunter2" });
    expect(mac.signed).toBe(false);
    expect(mac.identity).toBe("-");
  });

  it("hardens the runtime in both branches", () => {
    expect(macSigning({}).hardenedRuntime).toBe(true);
    expect(macSigning({ CALANDRIA_MAC_SIGN_IDENTITY: IDENTITY, ...API_KEY }).hardenedRuntime).toBe(true);
  });

  it("treats an explicit '-' as the ad-hoc request it is", () => {
    expect(macSigning({ CALANDRIA_MAC_SIGN_IDENTITY: "-" }).identity).toBe("-");
    expect(macSigning({ CALANDRIA_MAC_SIGN_IDENTITY: "  " }).identity).toBe("-");
  });

  it("signs and notarizes with a Developer ID plus an App Store Connect key", () => {
    const mac = macSigning({ CALANDRIA_MAC_SIGN_IDENTITY: IDENTITY, ...API_KEY });
    expect(mac.signed).toBe(true);
    expect(mac.notarize).toBe(true);
    expect(mac.identity).toBe(QUALIFIER);
    expect(mac.entitlements).toBe("build/entitlements.mac.plist");
    expect(mac.entitlementsInherit).toBe("build/entitlements.mac.plist");
  });

  // The first signed release lane died here, before packaging anything:
  // app-builder-lib's findIdentity throws InvalidConfigurationError on a
  // qualifier that carries a certificate type. Everything that documents,
  // stores or verifies this value uses the full name, so the strip lives in
  // macSigning rather than in the secret.
  it("hands electron-builder a qualifier, not a certificate type", () => {
    const cases: Array<[string, string]> = [
      ["Developer ID Application: Example (AB12CD34EF)", "Example (AB12CD34EF)"],
      ["Developer ID Installer: Example (AB12CD34EF)", "Example (AB12CD34EF)"],
      ["3rd Party Mac Developer Application: Example (AB12CD34EF)", "Example (AB12CD34EF)"],
      ["3rd Party Mac Developer Installer: Example (AB12CD34EF)", "Example (AB12CD34EF)"],
      // Already a qualifier, or a name no prefix matches: passed through, since
      // `_findIdentity` matches it as a substring of the find-identity line.
      ["Example (AB12CD34EF)", "Example (AB12CD34EF)"],
      ["Example Developer ID Application: Ltd", "Example Developer ID Application: Ltd"],
    ];
    for (const [configured, expected] of cases) {
      expect(macSigning({ CALANDRIA_MAC_SIGN_IDENTITY: configured, ...API_KEY }).identity).toBe(expected);
    }
  });

  it("refuses a certificate type with no name after it, rather than passing on an empty qualifier", () => {
    // "" would read to electron-builder as nothing configured, and it would
    // answer with keychain auto-discovery — signing with whatever it finds.
    expect(() => macSigning({ CALANDRIA_MAC_SIGN_IDENTITY: "Developer ID Application:", ...API_KEY })).toThrow(
      /certificate type with no name/i
    );
    expect(() => macSigning({ CALANDRIA_MAC_SIGN_IDENTITY: "Developer ID Application:   ", ...API_KEY })).toThrow(
      /certificate type with no name/i
    );
  });

  it("refuses to sign without notarizing — a signed, un-notarized build is still refused on download", () => {
    expect(() => macSigning({ CALANDRIA_MAC_SIGN_IDENTITY: IDENTITY })).toThrow(/no notarization credentials/i);
    // A lone APPLE_TEAM_ID is not a credential set; it must not read as one.
    expect(() => macSigning({ CALANDRIA_MAC_SIGN_IDENTITY: IDENTITY, APPLE_TEAM_ID: "AB12CD34EF" })).toThrow(
      /no notarization credentials/i
    );
  });

  it("has an escape hatch for signing without notarizing, and it has to be asked for", () => {
    const mac = macSigning({ CALANDRIA_MAC_SIGN_IDENTITY: IDENTITY, CALANDRIA_MAC_SKIP_NOTARIZE: "1" });
    expect(mac.signed).toBe(true);
    expect(mac.notarize).toBe(false);
    expect(mac.entitlements).toBe("build/entitlements.mac.plist");
  });

  it("names the missing variable when a credential group is half-filled", () => {
    expect(() => notarizeCredentials({ APPLE_API_KEY: API_KEY.APPLE_API_KEY })).toThrow(
      /APPLE_API_KEY_ID, APPLE_API_ISSUER/
    );
    expect(() => notarizeCredentials({ APPLE_ID: "someone@example.invalid" })).toThrow(
      /APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/
    );
  });

  it("prefers the App Store Connect key over an app-specific password", () => {
    const credentials = notarizeCredentials({
      ...API_KEY,
      APPLE_ID: "someone@example.invalid",
      APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
      APPLE_TEAM_ID: "AB12CD34EF",
    });
    expect(credentials?.kind).toBe("api-key");
  });

  it("reports no credentials rather than throwing when none were attempted", () => {
    expect(notarizeCredentials({})).toBeNull();
  });
});

describe("macOS entitlements", () => {
  // The <key> elements only. Both files explain themselves in an XML comment
  // that necessarily names the entitlement it is talking about, so a substring
  // search over the raw text would match the prose as readily as the policy.
  const keys = (name: string): string[] => {
    const plist = fs.readFileSync(path.join(DESKTOP, "build", name), "utf8");
    const withoutComments = plist.replace(/<!--[\s\S]*?-->/g, "");
    return [...withoutComments.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1].trim());
  };

  it("gives the Developer ID build JIT but not library-validation relief", () => {
    const entitlements = keys("entitlements.mac.plist");
    expect(entitlements).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    // The load-bearing assertion of this file. Hardened runtime enables library
    // validation, and the vendored resources/node/bin/node dlopens
    // better-sqlite3 and node-pty out of the payload. @electron/osx-sign signs
    // every Mach-O in the bundle with the same identity, so those loads should
    // succeed on their Team ID alone. If this entitlement ever gets added to
    // make a signed build start, something was signed by the wrong identity and
    // the entitlement would be hiding it.
    expect(entitlements).not.toContain("com.apple.security.cs.disable-library-validation");
  });

  it("gives the ad-hoc build the one extra entitlement an identity-less signature needs", () => {
    const entitlements = keys("entitlements.mac.adhoc.plist");
    expect(entitlements).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    expect(entitlements).toContain("com.apple.security.cs.disable-library-validation");
  });

  it("points both branches at files that exist", () => {
    for (const env of [{}, { CALANDRIA_MAC_SIGN_IDENTITY: IDENTITY, ...API_KEY }]) {
      const mac = macSigning(env);
      expect(fs.existsSync(path.join(DESKTOP, mac.entitlements))).toBe(true);
      expect(fs.existsSync(path.join(DESKTOP, mac.entitlementsInherit))).toBe(true);
    }
  });
});

describe("Windows signing policy", () => {
  it("ships unsigned when Azure Artifact Signing is not configured", () => {
    expect(windowsSigning({})).toEqual({ signed: false });
  });

  it("configures azureSignOptions from the four public variables", () => {
    const win = windowsSigning(AZURE);
    expect(win.signed).toBe(true);
    expect(win.azureSignOptions).toEqual({
      endpoint: AZURE.AZURE_CODE_SIGNING_ENDPOINT,
      codeSigningAccountName: AZURE.AZURE_CODE_SIGNING_ACCOUNT_NAME,
      certificateProfileName: AZURE.AZURE_CODE_SIGNING_CERT_PROFILE_NAME,
      publisherName: AZURE.AZURE_CODE_SIGNING_PUBLISHER_NAME,
    });
  });

  it("refuses a partial configuration rather than packaging a green unsigned installer", () => {
    const { AZURE_CODE_SIGNING_PUBLISHER_NAME, ...partial } = AZURE;
    expect(() => windowsSigning(partial)).toThrow(/AZURE_CODE_SIGNING_PUBLISHER_NAME/);
  });
});

describe("electron-builder config discovery", () => {
  // app-builder-lib's loader (out/util/config/load.js) reads package.json's
  // `build` field first and only scans for a standalone config file when that
  // field is absent. It neither merges nor warns, so a `build` key restored here
  // would shadow desktop/electron-builder.cjs entirely — every signing branch
  // above included — and every build would still go green.
  it("keeps desktop/package.json free of a build field", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
    expect(pkg.build).toBeUndefined();
  });

  // The loader probes `electron-builder` + an extension list. `.cjs` is on it;
  // `electron-builder.config.cjs`, the name most projects use, is not.
  it("keeps the config at the one filename electron-builder looks for", () => {
    expect(fs.existsSync(path.join(DESKTOP, "electron-builder.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(DESKTOP, "electron-builder.config.cjs"))).toBe(false);
  });

  it("assembles a config whose macOS block is ad-hoc by default", () => {
    // Loaded with a scrubbed environment: this file's whole point is that the
    // config reads process.env, and a developer with an Apple ID exported would
    // otherwise get a different object than CI does.
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
        mac: { identity: string; notarize: boolean; hardenedRuntime: boolean };
        win: Record<string, unknown>;
        artifactBuildCompleted: unknown;
      };
      expect(config.mac.identity).toBe("-");
      expect(config.mac.notarize).toBe(false);
      expect(config.mac.hardenedRuntime).toBe(true);
      expect(config.win.azureSignOptions).toBeUndefined();
      // artifactBuildCompleted, not afterAllArtifactBuild: it is awaited before
      // the artifact is announced to the publisher, so the .dmg is stapled
      // before a --publish run can start uploading it.
      expect(typeof config.artifactBuildCompleted).toBe("function");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
