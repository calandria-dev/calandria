/* Task 10's desktop-specific slice of Settings -> Advanced. The browser CRUD
 * flows themselves (add/edit/delete, catalog search, secret masking, stale
 * revisions) are already covered end to end by e2e/advanced-settings.spec.ts;
 * this file exercises what only a real desktop shell can prove:
 *
 *   1. A value saved here survives a real quit and relaunch (not a simulated
 *      boot), which also proves server.js and pty-server.js agree on the
 *      saved file, since a shell whose sidecar failed to boot never reaches
 *      a window at all.
 *   2. Running this spec against a packaged artifact (CALANDRIA_TEST_BIN, see
 *      desktop/README.md and 06-packaged.spec.ts) is what proves the
 *      lib/advanced-env/*.mjs runtime modules actually shipped in the
 *      payload: an unpackaged pass alone cannot catch a missing file here,
 *      since it would silently fall back to the source tree.
 *   3. A shell attached to a remote instance edits that server's file only;
 *      the local supervisor's own configuration, and a local server booted
 *      afterward, must show no trace of it.
 *   4. On win32, the saved file's ACL is owner-only, the same rule
 *      lib/secretFile.ts enforces for provider credentials.
 *
 * See docs/DESKTOP_E2E.md for prerequisites and the packaged-artifact
 * recipe.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  attachShellLog,
  bootRemoteServer,
  ensureOnboarded,
  instanceRoot,
  launchShell,
  quitShell,
  userDataDir,
  writeInstancesFile,
  type RemoteServer,
  type Shell,
} from "./fixtures";

test.describe.configure({ mode: "serial" });

async function openAdvanced(win: Page, origin: string): Promise<void> {
  await ensureOnboarded(origin);
  // Dismiss the first-run coach marks: their scrim otherwise intercepts the
  // click below (see 01-shell.spec.ts's identical setup before this same
  // ?view=settings navigation).
  await win.addInitScript(() => {
    localStorage.setItem("calandria_agent_nudge_dismissed", "1");
    localStorage.setItem("calandria:welcomeCoach:dismissed", "1");
  });
  await win.goto(`${origin}/?view=settings`);
  await win.locator(".settings-nav .nav-item", { hasText: "Advanced" }).click();
  await expect(win.getByRole("heading", { name: "App" })).toBeVisible();
  await expect(win.getByRole("heading", { name: "Agent sessions" })).toBeVisible();
}

async function addCustomVariable(win: Page, scope: "app" | "agent", name: string, value: string): Promise<void> {
  await win.getByTestId(`env-add-${scope}`).click();
  await win.getByTestId("env-catalog-custom").click();
  await win.getByTestId("env-name-input").fill(name);
  await win.getByTestId("env-value-input").fill(value);
  await win.getByTestId("env-save").click();
  await expect(win.getByTestId(new RegExp("^env-row-")).filter({ hasText: name })).toBeVisible();
}

function advancedEnvPathFor(root: string): string {
  return path.join(root, "db", "advanced-environment.json");
}

test.describe("local desktop restart persistence and app/PTY agreement", () => {
  let shell: Shell;
  const APP_NAME = "E2E_DESKTOP_APP_VAR";

  test.afterEach(async ({}, testInfo) => {
    await attachShellLog(testInfo, shell);
  });

  test("a saved app variable survives a real quit and relaunch, and the restart banner clears", async () => {
    shell = await launchShell("adv-settings-restart");
    await openAdvanced(shell.win, shell.origin);
    await addCustomVariable(shell.win, "app", APP_NAME, "first-boot");
    await expect(shell.win.getByTestId(new RegExp("^env-row-")).filter({ hasText: APP_NAME })).toContainText("Restart required");

    const root = shell.root;
    await quitShell(shell);

    // instanceRoot() mints a fresh directory per launchShell() call even with
    // the same name (desktop/e2e/fixtures.ts), so a real "same install,
    // relaunched" is expressed by pointing the second launch's db/worktrees/
    // projects and Electron user-data dir explicitly at the first one's,
    // rather than by reusing a name.
    shell = await launchShell("adv-settings-restart-2", {
      userDataDir: userDataDir(root),
      env: {
        CALANDRIA_DB_DIR: path.join(root, "db"),
        CALANDRIA_WORKTREES_DIR: path.join(root, "worktrees"),
        CALANDRIA_PROJECTS_DIR: path.join(root, "projects"),
      },
    });

    await openAdvanced(shell.win, shell.origin);
    const row = shell.win.getByTestId(new RegExp("^env-row-")).filter({ hasText: APP_NAME });
    await expect(row).toBeVisible();
    await expect(row).toContainText("first-boot");
    // Both server.js and pty-server.js came up against the same saved file
    // (a sidecar that disagreed with it, or failed to boot at all, would
    // have kept this shell on the boot screen and openAdvanced() above would
    // never have resolved); the value now matching what boot applied is what
    // clears the banner.
    await expect(shell.win.getByTestId("env-restart-banner")).toHaveCount(0);
  });
});

test.describe("Windows ACL on the saved settings file", () => {
  test.skip(process.platform !== "win32", "icacls only exists on win32; unavailable on this host.");

  test("the settings file grants only the owning account", async () => {
    const shell = await launchShell("adv-settings-acl");
    try {
      await openAdvanced(shell.win, shell.origin);
      await addCustomVariable(shell.win, "app", "E2E_DESKTOP_ACL_VAR", "v");

      const file = advancedEnvPathFor(shell.root);
      await expect.poll(() => fs.existsSync(file)).toBe(true);

      // Mirrors lib/secretFile.ts's windowsAclCommand(): the same rule this
      // file's own writer applies (lib/advanced-env/store.ts calls
      // restrictSecretFile() after every write).
      const out = execFileSync("icacls", [file], { encoding: "utf8" });
      expect(out).not.toMatch(/Everyone:|BUILTIN\\Users:|Authenticated Users:/i);
      const owner = process.env.USERNAME || process.env.USER || "";
      expect(out).toContain(owner);
    } finally {
      await quitShell(shell);
    }
  });
});

test.describe("a remote desktop instance edits only the remote server's state", () => {
  const REMOTE_NAME = "Advanced Remote";
  let remote: RemoteServer;
  let shell: Shell;

  test.afterEach(async ({}, testInfo) => {
    await attachShellLog(testInfo, shell);
  });

  test.afterAll(async () => {
    await quitShell(shell);
    await remote?.stop();
  });

  test("editing the connected remote's settings leaves the local supervisor's own file untouched", async () => {
    // CALANDRIA_INSTANCE_NAME is the server's own identity (lib/config.ts's
    // INSTANCE_NAME), distinct from the desktop app's own nickname for the
    // connection. Setting it here names this specific server in the Advanced
    // page's lede instead of falling back to its host header.
    remote = await bootRemoteServer("adv-settings-remote-server", { CALANDRIA_INSTANCE_NAME: REMOTE_NAME });
    await ensureOnboarded(remote.origin);

    const configRoot = instanceRoot("adv-settings-remote-config");
    const instancesFile = writeInstancesFile(configRoot, {
      active: "advremote",
      instances: [
        { id: "local", kind: "local", name: "This computer" },
        { id: "advremote", kind: "url", name: REMOTE_NAME, url: remote.origin },
      ],
    });

    shell = await launchShell("adv-settings-remote-shell", { env: { CALANDRIA_INSTANCES_FILE: instancesFile } });
    expect(shell.win.url().startsWith(remote.origin)).toBeTruthy();

    await openAdvanced(shell.win, shell.origin);
    // The connected-instance identity is shown above the tables
    // (app/shell/AdvancedSettingsSection.tsx), naming the server actually
    // being edited.
    await expect(shell.win.locator(".mv-lede")).toContainText(REMOTE_NAME);

    await addCustomVariable(shell.win, "app", "E2E_DESKTOP_REMOTE_VAR", "on-remote");

    // The remote server's own file has it...
    const remoteFile = advancedEnvPathFor(remote.root);
    await expect.poll(() => fs.existsSync(remoteFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(remoteFile, "utf8")).rows.some((r: { name: string }) => r.name === "E2E_DESKTOP_REMOTE_VAR")).toBe(true);

    // ...and the shell's own local instance directory, which never started a
    // server of its own while attached to the remote one, was never written.
    const localFile = advancedEnvPathFor(shell.root);
    expect(fs.existsSync(localFile)).toBe(false);
  });
});
