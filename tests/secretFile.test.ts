/* How a persisted API key is locked down on each platform.
 *
 * The POSIX half is the pre-existing behaviour and must not move: create at
 * 0600, re-chmod an existing file, and never fail the save over the chmod.
 * The win32 half can't run here — NTFS and icacls aren't available — so it is
 * pinned by structure, the way tests/binPath.test.ts pins the PATHEXT rules:
 * the platform is passed in and the command is asserted as argv, because
 * `chmod 0o600` on NTFS toggles the read-only attribute and nothing else
 * (docs/WINDOWS.md §3, finding 9). What matters most is the failure path — a
 * key file that outlived a failed ACL call would sit readable by every account
 * on the machine while the wizard reported a connected agent. The generated
 * VAPID keypair takes the opposite failure policy for a stated reason — see the
 * `fatal: false` case below.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SECRET_FILE_MODE,
  restrictSecretFile,
  secretFileOwner,
  windowsAclCommand,
  writeSecretFile,
} from "../lib/secretFile";
import { setApiKey, clearApiKey } from "../lib/anthropic-key";
import { setOpenAiKey, clearOpenAiKey } from "../lib/openai-key";
import { resetVapidCache, vapidKeys } from "../lib/push/vapid";
import { DB_DIR } from "../lib/config";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "secretfile-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

describe("writeSecretFile on POSIX", () => {
  it("creates the file, its parent, and the 0600 mode", () => {
    const file = path.join(dir, "nested", "anthropic-api-key");
    writeSecretFile(file, "sk-ant-secret", { platform: "linux" });
    expect(fs.readFileSync(file, "utf8")).toBe("sk-ant-secret");
    expect(modeOf(file)).toBe(SECRET_FILE_MODE);
  });

  it("narrows a file that already existed with a wider mode", () => {
    // writeFileSync's `mode` only applies at CREATE time — the chmod is what
    // repairs a key written before this policy, or one left by a bad umask.
    const file = path.join(dir, "key");
    fs.writeFileSync(file, "old", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    writeSecretFile(file, "new", { platform: "linux" });
    expect(modeOf(file)).toBe(SECRET_FILE_MODE);
  });

  it("never shells out", () => {
    const calls: string[] = [];
    writeSecretFile(path.join(dir, "key"), "k", { platform: "linux", run: (c) => calls.push(c) });
    expect(calls).toEqual([]);
  });

  it("swallows a chmod failure — the create-time mode already applied", () => {
    // Unchanged from the original setApiKey: POSIX chmod is belt-and-braces
    // over a mode writeFileSync already set, so it must not fail a good save.
    expect(() => restrictSecretFile(path.join(dir, "gone", "key"), { platform: "darwin" })).not.toThrow();
  });
});

describe("writeSecretFile on win32", () => {
  const opts = (run: (c: string, a: string[]) => void) => ({
    platform: "win32" as NodeJS.Platform,
    env: { SystemRoot: "C:\\Windows", USERNAME: "jgraham", COMPUTERNAME: "DESK1", USERDOMAIN: "DESK1" },
    owner: "jgraham",
    run,
  });

  it("sets an owner-only ACL instead of trusting the mode", () => {
    const file = path.join(dir, "key");
    const calls: Array<[string, string[]]> = [];
    writeSecretFile(file, "sk-ant-secret", opts((c, a) => calls.push([c, a])));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(path.join("C:\\Windows", "System32", "icacls.exe"));
    // /inheritance:r drops the profile-dir ACEs; /grant:r REPLACES the DACL, so
    // re-saving also repairs a file an older build left world-readable.
    expect(calls[0][1]).toEqual([file, "/inheritance:r", "/grant:r", "jgraham:(R,W)"]);
    expect(fs.readFileSync(file, "utf8")).toBe("sk-ant-secret");
  });

  it("deletes the key and throws when icacls is unavailable", () => {
    const file = path.join(dir, "key");
    expect(() =>
      writeSecretFile(file, "sk-ant-secret", opts(() => {
        throw Object.assign(new Error("spawnSync icacls.exe ENOENT"), { code: "ENOENT" });
      })),
    ).toThrow(/could not restrict/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("names the caller's escape hatch in the error", () => {
    // The route surfaces this string to the wizard, so it has to say what to do
    // next — the key modules pass the env fallback they already document.
    expect(() =>
      writeSecretFile(path.join(dir, "key"), "sk-ant-secret", {
        ...opts(() => {
          throw new Error("boom");
        }),
        advice: "Pass the key in the environment with CALANDRIA_ALLOW_API_KEY_ENV=1 instead.",
      }),
    ).toThrow(/It was NOT stored\. Pass the key in the environment with CALANDRIA_ALLOW_API_KEY_ENV=1/);
  });

  it("keeps the file and warns under fatal: false", () => {
    // The VAPID keypair's policy (lib/push/vapid.ts): the app mints it with no
    // user in the loop, so throwing here would take push notifications out
    // entirely on a filesystem with no ACLs. Smaller blast radius than an API
    // key — forged pushes to this instance's own subscribers, and unlike the
    // API keys it is not readable through /api/settings either.
    const file = path.join(dir, "vapid.json");
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      expect(() =>
        writeSecretFile(file, '{"privateKey":"x"}', {
          ...opts(() => {
            throw new Error("Command failed: icacls.exe … The system cannot find the path specified.");
          }),
          fatal: false,
          advice: "Set VAPID_PRIVATE_KEY in the environment to keep the signing key off disk.",
        }),
      ).not.toThrow();
    } finally {
      console.warn = warn;
    }
    expect(fs.readFileSync(file, "utf8")).toBe('{"privateKey":"x"}');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not restrict/);
    expect(warnings[0]).toMatch(/Set VAPID_PRIVATE_KEY in the environment/);
  });

  it("deletes the key and throws when icacls exits non-zero", () => {
    const file = path.join(dir, "key");
    expect(() =>
      writeSecretFile(file, "sk-ant-secret", opts(() => {
        throw new Error("Command failed: icacls.exe … No mapping between account names and security IDs");
      })),
    ).toThrow(/No mapping between account names/);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("windowsAclCommand", () => {
  it("pins icacls to %SystemRoot%\\System32 rather than PATH order", () => {
    // A PATH-resolved icacls is one writable directory away from being someone
    // else's program that exits 0 — and this call is the whole protection.
    expect(windowsAclCommand("C:\\k", "u", { SystemRoot: "C:\\Windows" }).command).toBe(
      path.join("C:\\Windows", "System32", "icacls.exe"),
    );
    expect(windowsAclCommand("C:\\k", "u", { windir: "D:\\Win" }).command).toBe(
      path.join("D:\\Win", "System32", "icacls.exe"),
    );
    expect(windowsAclCommand("C:\\k", "u", {}).command).toBe("icacls");
  });
});

describe("secretFileOwner", () => {
  // The account comes from os.userInfo() — authoritative on both platforms, and
  // what the env is only a fallback for. Only the DOMAIN half is env-derived.
  const me = os.userInfo().username;

  it("qualifies the account with USERDOMAIN when it isn't this machine", () => {
    // Shadowing is the hazard: icacls resolves a bare name through
    // LookupAccountName, which checks the local machine before the domain.
    expect(secretFileOwner({ USERDOMAIN: "CORP", COMPUTERNAME: "DESK1" })).toBe(`CORP\\${me}`);
    expect(secretFileOwner({ USERDOMAIN: "AzureAD", COMPUTERNAME: "DESK1" })).toBe(`AzureAD\\${me}`);
  });

  it("leaves a standalone machine's account bare", () => {
    expect(secretFileOwner({ USERDOMAIN: "DESK1", COMPUTERNAME: "desk1" })).toBe(me);
    expect(secretFileOwner({})).toBe(me);
  });
});

describe("the secrets on the volume go through it", () => {
  afterEach(() => {
    clearApiKey();
    clearOpenAiKey();
  });

  it("writes both key files owner-only", () => {
    setApiKey("sk-ant-test-key");
    setOpenAiKey("sk-test-key");
    expect(modeOf(path.join(DB_DIR, "anthropic-api-key"))).toBe(SECRET_FILE_MODE);
    expect(modeOf(path.join(DB_DIR, "openai-api-key"))).toBe(SECRET_FILE_MODE);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-test-key");
    expect(process.env.OPENAI_API_KEY).toBe("sk-test-key");
  });

  it("writes the generated VAPID keypair owner-only too", () => {
    // Same NTFS no-op, one directory over: the private half signs every Web
    // Push JWT this instance sends. Only the POSIX mode is observable from
    // here; the win32 ACL it now also gets is pinned structurally above.
    const file = path.join(DB_DIR, "vapid.json");
    fs.rmSync(file, { force: true });
    resetVapidCache();
    const keys = vapidKeys();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).privateKey).toBe(keys.privateKey);
    expect(modeOf(file)).toBe(SECRET_FILE_MODE);
    resetVapidCache();
  });
});
