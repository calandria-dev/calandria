#!/usr/bin/env node
"use strict";

// Apply electron-builder PR #10101 to the installed app-builder-lib, because the
// released v26 line does not carry it and macOS signing cannot work without it.
//
// THE BUG. app-builder-lib's `createKeychain()` makes a throwaway keychain with a
// random password, imports the .p12 into it, and then runs
//
//   security set-key-partition-list -S apple-tool:,apple: -s -k <password> <keychain>
//
// to grant codesign access to the imported key. `-k` takes the KEYCHAIN's unlock
// password. What it is handed is the .p12's IMPORT password — CSC_KEY_PASSWORD —
// because `createKeychain` never threads its `keychainPassword` into
// `importCerts()`. The two are unrelated strings, so the argument has always been
// wrong.
//
// WHY IT ONLY BROKE NOW. `set-key-partition-list` unlocks the keychain before it
// writes the partition list, and the keychain is already unlocked at that point —
// `createKeychain` ran `unlock-keychain` moments earlier. Through macOS 26.5 the
// already-unlocked case ignored `-k` and the wrong password cost nothing. macOS
// 26.6.2, which arrived on the GitHub `macos-26-arm64` runner image in build
// 20260831.0337.3, checks it regardless, and every signed build since fails with
//
//   security: SecKeychainUnlock: The user name or passphrase you entered is not correct.
//
// v0.9.0 signed on image 20260728.0273.1 and v0.10.0 failed on 20260831.0337.3
// with an identical tree, twice, so this is the runner image uncovering a latent
// defect rather than anything in this repository.
//
// WHY A PATCH AND NOT A VERSION BUMP. There is no released version to bump to.
// The fix is electron-builder PR #10101 (merged 2026-08-27, issue #10066); it
// went to the v27 alpha line only, was reported missing from 26.16.0 as #10167,
// and the v26 backport PR #10172 merged on 2026-09-03 is still unpublished — npm's
// `v26` dist-tag is 26.16.0 and there is no 26.16.1.
//
// WHY A PATCH AND NOT OUR OWN KEYCHAIN. Setting CSC_KEYCHAIN and importing the
// certificate ourselves does work — `macPackager.js` skips `createKeychain()`
// entirely when CSC_LINK is unset — but it also skips `bundledCertKeychainAdded`,
// which is what puts Apple's root certificates on the search list and so what
// makes `security find-identity -v` call our Developer ID identity VALID. This
// changes one argument to one command instead, leaving the path that produced
// every release through v0.9.0 otherwise untouched.
//
// IT RETIRES ITSELF. When a fixed app-builder-lib is installed the patched shape
// is already present and this is a no-op that says so, so the bump that makes it
// unnecessary does not also make it a failure. Delete this file and its caller
// once desktop/package-lock.json carries a version with #10172 in it.

const fs = require("fs");
const path = require("path");

const TARGET = path.join(
  __dirname,
  "..",
  "node_modules",
  "app-builder-lib",
  "out",
  "codeSign",
  "macCodeSign.js"
);

// Each of the three is unique in app-builder-lib 26.15.3's macCodeSign.js, which
// is what makes a plain string replacement safe. `replaceOnce` re-checks that on
// every run rather than trusting the pin.
const REPLACEMENTS = [
  [
    "return await importCerts(keychainFile, certPaths, cscPasswords);",
    "return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);",
  ],
  [
    "async function importCerts(keychainFile, paths, keyPasswords) {",
    "async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {",
  ],
  ['"-k", password, keychainFile]', '"-k", keychainPassword, keychainFile]'],
];

// The shape the patch leaves behind, and the shape a fixed upstream ships.
const ALREADY_FIXED = '"-k", keychainPassword, keychainFile]';

function replaceOnce(source, from, to) {
  const first = source.indexOf(from);
  if (first === -1) {
    throw new Error(`could not find ${JSON.stringify(from)}`);
  }
  if (source.indexOf(from, first + from.length) !== -1) {
    throw new Error(`${JSON.stringify(from)} appears more than once`);
  }
  return source.slice(0, first) + to + source.slice(first + from.length);
}

// Only macOS signs, so only macOS may fail. On Linux and Windows an unrecognized
// file is worth saying out loud and nothing more: failing there would take two
// artifacts that build fine down with the one that does not, which is the whole
// reason the release matrix runs fail-fast: false.
function giveUp(reason) {
  const message =
    `${reason}. app-builder-lib's macCodeSign.js is not the shape this patch was ` +
    `written against — re-check electron-userland/electron-builder#10066 and ` +
    `whether the installed version already carries the fix from #10172.`;
  if (process.platform === "darwin") {
    console.error(`patch-electron-builder-keychain: ${message}`);
    process.exit(1);
  }
  console.warn(`patch-electron-builder-keychain: ${message} Not darwin; continuing.`);
  process.exit(0);
}

if (!fs.existsSync(TARGET)) {
  giveUp(`${TARGET} does not exist`);
}

const original = fs.readFileSync(TARGET, "utf8");

if (original.includes(ALREADY_FIXED)) {
  console.log(
    "patch-electron-builder-keychain: app-builder-lib already passes the keychain " +
      "password to set-key-partition-list. Nothing to do — this patch can be deleted."
  );
  process.exit(0);
}

let patched = original;
try {
  for (const [from, to] of REPLACEMENTS) {
    patched = replaceOnce(patched, from, to);
  }
} catch (error) {
  giveUp(error.message);
}

fs.writeFileSync(TARGET, patched);
console.log(
  "patch-electron-builder-keychain: applied electron-builder#10101 — " +
    "set-key-partition-list now receives the keychain password, not the .p12 password."
);
