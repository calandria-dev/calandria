#!/usr/bin/env node
"use strict";

// Apply electron-builder PR #10101 to the installed app-builder-lib: the
// released v26 line does not carry it, and macOS signing cannot work without it.
//
// app-builder-lib's `createKeychain()` makes a throwaway keychain with a
// random password, imports the .p12 into it, and then runs
//
//   security set-key-partition-list -S apple-tool:,apple: -s -k <password> <keychain>
//
// to grant codesign access to the imported key. `-k` takes the keychain's own
// unlock password, but it is handed the .p12's import password
// (CSC_KEY_PASSWORD) instead, because `createKeychain` never threads its
// `keychainPassword` into `importCerts()`. Some macOS versions enforce that
// check even on a keychain that is already unlocked, so a signed build then
// fails with `security: SecKeychainUnlock: The user name or passphrase you
// entered is not correct.`
//
// A patch, not a version bump: there is no released version to bump to. The
// fix is electron-builder PR #10101 (issue #10066); it landed on the v27
// alpha line, was reported missing from 26.16.0 as #10167, and the v26
// backport (PR #10172) is not yet published. npm's `v26` dist-tag is 26.16.0
// and there is no 26.16.1.
//
// A patch, not our own keychain: setting CSC_KEYCHAIN and importing the
// certificate ourselves works (`macPackager.js` skips `createKeychain()`
// entirely when CSC_LINK is unset), but it also skips
// `bundledCertKeychainAdded`, which puts Apple's root certificates on the
// search list and is needed for `security find-identity -v` to treat our
// Developer ID identity as valid. Changing one argument to one command
// leaves the rest of the signing path untouched.
//
// It retires itself: once a fixed app-builder-lib is installed, the patched
// shape is already present and this becomes a no-op that says so. Delete
// this file and its caller once desktop/package-lock.json carries a version
// with #10172 in it.

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

// Each of the three is unique in app-builder-lib 26.15.3's macCodeSign.js, so a
// plain string replacement is safe. `replaceOnce` re-checks that on every run
// instead of trusting the pin.
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

// Never fails an install, on any platform. This runs from `postinstall`, so a
// throw here would stop `npm install` in desktop/ for everybody, including the
// Linux and Windows release legs, which do not sign and are not affected, and a
// developer who only wants to run the app. The release matrix uses
// fail-fast: false to stop one platform's problem taking the other two's
// artifacts down; a dependency-install script that exits non-zero would undo
// that.
//
// An unpatched macOS build still fails, at the "Package and publish" step,
// with the SecKeychainUnlock error quoted above, documented in
// docs/DESKTOP_APP.md §6.4.1. A named, specific failure on the affected
// platform only is preferable to breaking `npm install` for everyone the day
// upstream reorganizes a file.
function giveUp(reason) {
  console.warn(
    `patch-electron-builder-keychain: ${reason}. app-builder-lib's macCodeSign.js ` +
      `is not the shape this patch was written against, so macOS signing may fail ` +
      `with "SecKeychainUnlock: The user name or passphrase you entered is not ` +
      `correct". Re-check electron-userland/electron-builder#10066 and whether ` +
      `the installed version already carries the fix from #10172. Continuing.`
  );
  process.exit(0);
}

if (!fs.existsSync(TARGET)) {
  giveUp(`${TARGET} does not exist`);
}

const original = fs.readFileSync(TARGET, "utf8");

if (original.includes(ALREADY_FIXED)) {
  console.log(
    "patch-electron-builder-keychain: app-builder-lib already passes the keychain " +
      "password to set-key-partition-list. Nothing to do; this patch can be deleted."
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
  "patch-electron-builder-keychain: applied electron-builder#10101. " +
    "set-key-partition-list now receives the keychain password, not the .p12 password."
);
