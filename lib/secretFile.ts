// Writing a credential to disk so that only this account can read it — the
// persisted API keys (lib/anthropic-key.ts, lib/openai-key.ts).
//
// On POSIX that is `mode: 0o600` at create time plus a best-effort chmod for a
// file that already existed with a wider mode. On NTFS it is neither: Node's
// chmod maps onto the FAT-era read-only attribute, so `0o600` toggles nothing
// but the write bit and the file stays readable by every other local account.
// The comments in those modules promised owner-only and silently didn't have
// it (docs/WINDOWS.md §3, finding 9).
//
// So win32 gets a real ACL instead: `icacls <file> /inheritance:r /grant:r
// <owner>:(R,W)` — `/inheritance:r` drops the ACEs inherited from the profile
// directory, `/grant:r` REPLACES the DACL rather than adding to it, so re-saving
// a key also repairs a file written by an older build. A local administrator can
// still take ownership; that is not defensible from user space and is not what
// this is defending against.
//
// **Failure is fatal, deliberately.** A credential on disk with permissions we
// could not set is worse than no credential: the wizard would report a
// connected agent while the key sat world-readable. If the ACL step fails the
// file is removed and the error propagates to the route, which surfaces it; the
// escape hatch is the one that already exists — pass the key in the process
// environment and set CALANDRIA_ALLOW_API_KEY_ENV (lib/env-keys.mjs).
//
// Every function takes its platform/env as arguments so the win32 rules are
// unit-testable from the Linux/macOS suite, the same way lib/binPath.ts does it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Owner read/write, nothing for group or other. Honored on POSIX only. */
export const SECRET_FILE_MODE = 0o600;

/** Just the variables read here — Next's typegen makes NODE_ENV required on NodeJS.ProcessEnv. */
export type SecretFileEnv = Record<string, string | undefined>;

export interface SecretFileOptions {
  /** Defaults to the running platform; pass "win32" to exercise the ACL rules. */
  platform?: NodeJS.Platform;
  /** Defaults to process.env — read for the owner name and for %SystemRoot%. */
  env?: SecretFileEnv;
  /** The Windows account to grant; defaults to secretFileOwner(). */
  owner?: string;
  /** Seam for the suite: runs a command, throwing on ENOENT or a non-zero exit. */
  run?: (command: string, args: string[]) => void;
}

const isWin = (platform?: NodeJS.Platform) => (platform ?? process.platform) === "win32";

/**
 * Who to grant the file to. `os.userInfo()` gives the bare account name, which
 * icacls resolves through LookupAccountName — built-ins, then the local
 * machine, then trusted domains — so a domain account can be shadowed by a
 * local one of the same name. `USERDOMAIN` disambiguates it when it names
 * something other than this machine (a real domain, or `AzureAD` on an
 * Entra-joined box); on a standalone machine it equals `COMPUTERNAME` and the
 * bare name is already unambiguous.
 */
export function secretFileOwner(env: SecretFileEnv = process.env): string {
  let user = "";
  try {
    user = os.userInfo().username || "";
  } catch {
    /* no passwd/registry entry for this uid — fall through to the env */
  }
  if (!user) user = env.USERNAME || env.USER || "";
  if (!user) throw new Error("cannot determine the current user to grant the key file to");
  const domain = env.USERDOMAIN;
  if (domain && domain.toLowerCase() !== (env.COMPUTERNAME || "").toLowerCase()) {
    return `${domain}\\${user}`;
  }
  return user;
}

/**
 * The icacls invocation for `filePath`. Pinned to `%SystemRoot%\System32` when
 * the environment names it rather than trusting PATH order: this call is the
 * thing standing between a credential and every other account on the machine,
 * and a PATH-resolved `icacls` is one writable directory away from being
 * someone else's program that exits 0.
 */
export function windowsAclCommand(
  filePath: string,
  owner: string,
  env: SecretFileEnv = process.env,
): { command: string; args: string[] } {
  const root = env.SystemRoot || env.windir;
  return {
    command: root ? path.join(root, "System32", "icacls.exe") : "icacls",
    args: [filePath, "/inheritance:r", "/grant:r", `${owner}:(R,W)`],
  };
}

function defaultRun(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "pipe", windowsHide: true });
}

/**
 * Restrict an existing file to its owner. Best-effort on POSIX (the create-time
 * mode already did the work); on win32 it throws if the ACL could not be set.
 */
export function restrictSecretFile(filePath: string, opts: SecretFileOptions = {}): void {
  if (!isWin(opts.platform)) {
    try {
      fs.chmodSync(filePath, SECRET_FILE_MODE);
    } catch {
      /* mode was already applied at create time; a chmod failure here is not fatal */
    }
    return;
  }
  const env = opts.env ?? process.env;
  const { command, args } = windowsAclCommand(filePath, opts.owner ?? secretFileOwner(env), env);
  try {
    (opts.run ?? defaultRun)(command, args);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `could not restrict ${filePath} to ${opts.owner ?? "the current user"} (${command}): ${detail}. ` +
        `Windows ignores POSIX file modes, so the key was NOT stored — it would have been readable ` +
        `by every account on this machine. Pass the key in the environment with ` +
        `CALANDRIA_ALLOW_API_KEY_ENV=1 instead.`,
    );
  }
}

/**
 * Write `contents` to `filePath` readable only by this account, creating the
 * parent directory. On a failure to restrict it, the file is removed before the
 * error propagates — never leave a credential behind at unknown permissions.
 */
export function writeSecretFile(filePath: string, contents: string, opts: SecretFileOptions = {}): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode: SECRET_FILE_MODE });
  try {
    restrictSecretFile(filePath, opts);
  } catch (e) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* nothing more we can do; the throw below is what matters */
    }
    throw e;
  }
}
