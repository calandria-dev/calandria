// Writes a credential to disk readable only by this account: the persisted
// API keys (lib/anthropic-key.ts, lib/openai-key.ts) and the generated VAPID
// keypair (lib/push/vapid.ts). POSIX uses `mode: 0o600` plus a best-effort
// chmod; Windows ignores POSIX modes, so win32 runs `icacls <file>
// /inheritance:r /grant:r <owner>:(R,W)` to replace the DACL with owner-only
// read/write. Failure is fatal by default: the file is removed and the error
// propagates, unless the caller passes `fatal: false`, used only for the
// VAPID keypair, which warns and keeps the key instead.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Owner read/write, nothing for group or other. Honored on POSIX only. */
export const SECRET_FILE_MODE = 0o600;

/** The variables read here. Next's typegen makes NODE_ENV required on NodeJS.ProcessEnv. */
export type SecretFileEnv = Record<string, string | undefined>;

export interface SecretFileOptions {
  /** Defaults to the running platform; pass "win32" to exercise the ACL rules. */
  platform?: NodeJS.Platform;
  /** Defaults to process.env, read for the owner name and for %SystemRoot%. */
  env?: SecretFileEnv;
  /** The Windows account to grant; defaults to secretFileOwner(). */
  owner?: string;
  /** Seam for the suite: runs a command, throwing on ENOENT or a non-zero exit. */
  run?: (command: string, args: string[]) => void;
  /**
   * Default true: a file that could not be made owner-only is deleted and the
   * error thrown. False keeps it and logs a warning; use only for a secret the
   * app generated itself, where refusing would break a feature with nobody
   * watching.
   */
  fatal?: boolean;
  /** One sentence naming this caller's way to keep the secret off disk, appended to the error or warning. */
  advice?: string;
}

const isWin = (platform?: NodeJS.Platform) => (platform ?? process.platform) === "win32";

/**
 * Who to grant the file to. `os.userInfo()` gives the bare account name,
 * which icacls resolves through LookupAccountName (built-ins, then the local
 * machine, then trusted domains), so a domain account can be shadowed by a
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
    /* no passwd/registry entry for this uid; fall through to the env */
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
 * The icacls invocation for `filePath`. Pinned to `%SystemRoot%\System32`
 * when the environment names it, so a PATH-resolved `icacls` binary (one
 * writable directory away from being someone else's program that exits 0)
 * can't be substituted. This call is what stands between a credential and
 * every other account on the machine.
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
        `Windows ignores POSIX file modes, so this file is readable by every account on this machine.`,
    );
  }
}

/**
 * Write `contents` to `filePath` readable only by this account, creating the
 * parent directory. On a failure to restrict it, the file is removed and the
 * error propagates, so no credential is left behind at unknown permissions,
 * unless the caller passed `fatal: false`, which keeps the file and warns
 * instead.
 */
export function writeSecretFile(filePath: string, contents: string, opts: SecretFileOptions = {}): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode: SECRET_FILE_MODE });
  try {
    restrictSecretFile(filePath, opts);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const advice = opts.advice ? ` ${opts.advice}` : "";
    if (opts.fatal === false) {
      console.warn(`[secret-file] ${detail} Keeping it anyway. The alternative is losing the feature it belongs to.${advice}`);
      return;
    }
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* nothing more we can do; the throw below is what matters */
    }
    throw new Error(`${detail} It was NOT stored.${advice}`);
  }
}
