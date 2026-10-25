/* Native instance sign-in: desktop/oauth.js, desktop/instance-auth.js and the
 * "Instance sign-in" section of desktop/main.js. See oauth.js's header for why
 * this exists: a passkey or a security key cannot be used from inside the
 * shell's own window, so a configured (`auth: { kind: "oauth", … }`) instance
 * never renders its identity provider's login page there at all. It shows
 * signin.html, and pressing its button runs the RFC 8252 flow (PKCE S256,
 * loopback redirect on 127.0.0.1) in the user's real browser instead.
 *
 * `desktop/e2e/ssoStub.ts` is the fake forward-auth proxy and OIDC provider
 * this drives the flow against.
 *
 * THE TEST IS THE BROWSER. `shell.openExternal` is replaced in the main process
 * (the same move 01-shell.spec.ts makes to prove external links leave the
 * window) so the authorize URL is recorded instead of opened, and this process
 * then fetches it with redirects followed, which lands on the app's loopback
 * receiver exactly as a real browser would. `openExternal` on Windows resolves
 * through ShellExecute, so an `xdg-open` PATH shim only intercepts on Linux and
 * must not be relied on cross-platform.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { attachShellLog, instanceRoot, launchShell, quitShell, writeInstancesFile, type Shell } from "./fixtures";
import { startSsoStub, type SsoStub } from "./ssoStub";

test.describe.configure({ mode: "serial" });

const INSTANCE_NAME = "Stub";
const INSTANCE_ID = "ab12";

let stub: SsoStub;
let shell: Shell;
let credentialsFile: string;
let instancesFile: string;
// What the app asked the browser to open, read back out of the main process.
let authorizeUrl = "";
// The redirect chain that fetching it produced, ending at the loopback receiver.
let landedOn = "";

test.beforeAll(async () => {
  stub = await startSsoStub();

  const root = instanceRoot("instance-auth-config");
  fs.mkdirSync(root, { recursive: true });

  credentialsFile = path.join(root, "credentials.json");
  instancesFile = writeInstancesFile(root, {
    active: INSTANCE_ID,
    instances: [
      { id: "local", kind: "local", name: "This computer" },
      {
        id: INSTANCE_ID,
        kind: "url",
        name: INSTANCE_NAME,
        url: stub.appOrigin,
        auth: { kind: "oauth", issuer: stub.idpOrigin, clientId: stub.clientId },
      },
    ],
  });

  shell = await launchShell("instance-auth", {
    // The window lands on signin.html (a file:// URL) rather than an
    // http://127.0.0.1 origin, which is what launchShell normally waits for.
    waitForApp: false,
    env: {
      CALANDRIA_INSTANCES_FILE: instancesFile,
      CALANDRIA_CREDENTIALS_FILE: credentialsFile,
    },
  });

  // Stand in for the system browser. Recording the URL rather than opening it
  // keeps the ceremony in this process, where it can be asserted on, and keeps
  // a real browser off a CI runner that may not have one.
  await shell.app.evaluate(({ shell: electronShell }) => {
    (globalThis as any).__openedExternally = [];
    electronShell.openExternal = async (url: string) => {
      (globalThis as any).__openedExternally.push(url);
    };
  });
});

/** What the app has asked the browser to open so far. */
async function openedExternally(): Promise<string[]> {
  return await shell.app.evaluate(() => (globalThis as any).__openedExternally ?? []);
}

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  await quitShell(shell);
  await stub?.stop();
});

test("the identity provider's own page is never rendered", async () => {
  await shell.win.waitForSelector("#signin:not([hidden])", { timeout: 30_000 });
  const url = shell.win.url();
  expect(url.endsWith("/signin.html"), `the window is on the app's own sign-in page (${url})`).toBeTruthy();
  expect(url.includes(String(new URL(stub.idpOrigin).port)), "the window never navigated to the provider").toBe(
    false,
  );
  await expect(shell.win.locator("#heading")).toContainText(INSTANCE_NAME);
});

test("pressing sign-in runs the whole flow and the app attaches", async () => {
  await shell.win.click("#signin");

  // The window swaps to the waiting state while the browser has the flow.
  await shell.win
    .waitForFunction(() => !document.getElementById("spinner")?.hidden, null, { timeout: 10_000 })
    .catch(() => {});

  await expect.poll(async () => (await openedExternally()).length, { timeout: 20_000 }).toBeGreaterThan(0);
  authorizeUrl = (await openedExternally())[0];
  expect(authorizeUrl, "the authorize URL went to the system browser").toMatch(/^http/);
  expect(authorizeUrl, "the authorize URL carried an S256 PKCE challenge").toContain("code_challenge_method=S256");

  // Now be the browser: follow the chain, which ends at the app's loopback
  // receiver and hands it the code.
  const landed = await fetch(authorizeUrl, { redirect: "follow" });
  landedOn = landed.url;
  expect(landed.status, "the loopback receiver answered the callback").toBe(200);
  expect(landedOn, "the browser landed on the app's loopback redirect").toMatch(
    /^http:\/\/127\.0\.0\.1:\d+\/callback\?code=/,
  );

  await expect
    .poll(() => shell.log.some((l) => l.includes("[shell] attached to")), { timeout: 40_000 })
    .toBe(true);

  const stubText = stub.log.join("\n");
  expect(stubText, "the code was exchanged with a verifier the provider accepted").toMatch(
    /token grant=authorization_code client=calandria-desktop pkce_ok=true/,
  );
  expect(stubText, "the instance saw the token on the version handshake").toMatch(/GET \/api\/version auth=ok/);
  expect(stubText, "no request ever carried the wrong credential").not.toMatch(/auth=wrong/);

  // And the window is now on the instance's own page, not the sign-in screen.
  await shell.win.waitForSelector("#app-loaded", { timeout: 15_000 });
});

test("the token is scoped and stored, never in instances.json", async () => {
  const creds = JSON.parse(fs.readFileSync(credentialsFile, "utf8"));
  expect(creds.credentials?.[INSTANCE_ID], "a credential was persisted for this instance").toBeTruthy();

  if (process.platform !== "win32") {
    const mode = fs.statSync(credentialsFile).mode & 0o777;
    expect(mode, `credentials.json is 0600 (got ${mode.toString(8)})`).toBe(0o600);
  }

  const instancesText = fs.readFileSync(instancesFile, "utf8");
  expect(instancesText).not.toContain(stub.token);
  expect(instancesText).not.toContain("access_token");
});

test("no third party sees the instance's bearer token", async () => {
  // The stub app's own page embeds an <img> pointing at the IDP's origin
  // (ssoStub.ts). The window's session stamps the credential on requests to
  // the instance's own origin only (armAuthHeaders, main.js); a listener
  // that stamped every request in the partition would leak it here.
  await expect
    .poll(() => stub.log.some((l) => l.startsWith("GET /asset auth=")), { timeout: 15_000 })
    .toBe(true);
  const assetLines = stub.log.filter((l) => l.startsWith("GET /asset auth="));
  expect(assetLines.every((l) => l === "GET /asset auth=none")).toBe(true);
});

test("signing out clears the stored credential", async () => {
  const dialogOpened = shell.app.waitForEvent("window", { timeout: 30_000 });
  await shell.app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("instance-manage");
    if (!item) throw new Error("no instance-manage menu item");
    item.click();
  });
  const dialog = await dialogOpened;
  const signOut = dialog.getByRole("button", { name: "Sign out" });
  await signOut.waitFor({ timeout: 15_000 });
  // THIS CLICK DESTROYS THE PAGE IT IS ISSUED IN. Resolving the dialog's
  // injected promise closes the modal (`openInstanceDialog` answers from
  // `closed`, not from the click), so Playwright's post-click wait can race
  // the window teardown and lose on a slow runner, failing with
  // "Target page, context or browser has been closed".
  //
  // The click is therefore fire-and-forget, and what the test asserts on is the
  // OUTCOME below: the credential is gone and the window is back on the
  // sign-in screen. A click that silently failed to land still fails the test,
  // it just fails on the thing that matters rather than on the teardown.
  await signOut.click({ noWaitAfter: true }).catch(() => {});

  // Sign-out re-attaches the (still active) instance, which finds no
  // credential and lands back on signin.html.
  await expect
    .poll(
      () => {
        const w = shell.app.windows().find((p) => p.url().endsWith("/signin.html"));
        return !!w;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  shell.win = shell.app.windows().find((p) => p.url().endsWith("/signin.html"))!;

  // Polled rather than read once: clearing the credential and re-attaching are
  // two steps of one handler, and the window reaching signin.html does not
  // promise the file has been rewritten yet.
  await expect
    .poll(
      () => {
        try {
          return !!JSON.parse(fs.readFileSync(credentialsFile, "utf8")).credentials?.[INSTANCE_ID];
        } catch {
          return false;
        }
      },
      { message: "the credential was removed on sign-out", timeout: 15_000 },
    )
    .toBe(false);
});

/* ---- A `header`-kind instance: no sign-in screen at all ------------------ */

test.describe("a header-kind instance sends its stored headers with no sign-in screen", () => {
  let headerStub: SsoStub;
  let headerShell: Shell | undefined;

  test.beforeAll(async () => {
    headerStub = await startSsoStub();

    const root = instanceRoot("instance-auth-header-config");
    const credsFile = path.join(root, "credentials.json");
    const headerId = "cd34";
    // Pre-seeded in the `plain` shape instance-auth.js's loadCredentials reads
    // (loadCredentials/saveCredentials, desktop/instance-auth.js), as if a
    // previous run had already stored a header credential.
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        version: 1,
        credentials: {
          [headerId]: { enc: "plain", data: { kind: "header", headers: { Authorization: `Bearer ${headerStub.token}` } } },
        },
      }),
    );
    const instancesFile = writeInstancesFile(root, {
      active: headerId,
      instances: [
        { id: "local", kind: "local", name: "This computer" },
        { id: headerId, kind: "url", name: "Header stub", url: headerStub.appOrigin, auth: { kind: "header" } },
      ],
    });

    headerShell = await launchShell("instance-auth-header", {
      env: { CALANDRIA_INSTANCES_FILE: instancesFile, CALANDRIA_CREDENTIALS_FILE: credsFile },
    });
  });

  test.afterAll(async () => {
    await quitShell(headerShell);
    await headerStub?.stop();
  });

  test("the window attaches straight to the instance", async () => {
    expect(headerShell!.win.url().startsWith(headerStub.appOrigin)).toBeTruthy();
    await headerShell!.win.waitForSelector("#app-loaded", { timeout: 20_000 });
    expect(headerStub.log.some((l) => l.includes("GET /api/version auth=ok"))).toBeTruthy();
  });
});

/* ---- A revoked refresh token: one attempt, then the sign-in screen ------- */

test.describe("a refresh token the provider revoked stops renewing and asks for a sign-in (#477)", () => {
  // The renewal is armed for this long after launch, which leaves the attach
  // time to finish on the still-valid access token first, so what the test
  // observes is the background renewal timer, the path that looped in #477.
  const RENEW_AFTER_MS = 25_000;
  // instance-auth.js's REFRESH_SKEW_MS: the timer fires this long before expiry.
  const SKEW_MS = 60_000;
  const revokedId = "ef56";
  let revokedStub: SsoStub;
  let revokedShell: Shell | undefined;
  let credsFile: string;

  const refreshGrants = () => revokedStub.log.filter((l) => l.startsWith("token grant=refresh_token")).length;

  test.beforeAll(async () => {
    revokedStub = await startSsoStub();

    const root = instanceRoot("instance-auth-revoked-config");
    fs.mkdirSync(root, { recursive: true });
    credsFile = path.join(root, "credentials.json");
    // A previous run's sign-in: the access token still works, and the refresh
    // token is one the stub's token endpoint refuses with `invalid_grant`,
    // exactly as a provider that rotated or revoked it does.
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        version: 1,
        credentials: {
          [revokedId]: {
            enc: "plain",
            data: {
              kind: "oauth",
              tokenType: "Bearer",
              accessToken: revokedStub.token,
              refreshToken: "a-refresh-token-the-provider-revoked",
              obtainedAt: Date.now(),
              expiresAt: Date.now() + SKEW_MS + RENEW_AFTER_MS,
            },
          },
        },
      }),
    );
    const instancesFile = writeInstancesFile(root, {
      active: revokedId,
      instances: [
        { id: "local", kind: "local", name: "This computer" },
        {
          id: revokedId,
          kind: "url",
          name: "Revoked stub",
          url: revokedStub.appOrigin,
          auth: { kind: "oauth", issuer: revokedStub.idpOrigin, clientId: revokedStub.clientId },
        },
      ],
    });

    revokedShell = await launchShell("instance-auth-revoked", {
      env: { CALANDRIA_INSTANCES_FILE: instancesFile, CALANDRIA_CREDENTIALS_FILE: credsFile },
    });
  });

  test.afterEach(async ({}, testInfo) => {
    if (revokedShell) await attachShellLog(testInfo, revokedShell);
  });

  test.afterAll(async () => {
    await quitShell(revokedShell);
    await revokedStub?.stop();
  });

  test("the stored credential attaches before the renewal is due", async () => {
    await revokedShell!.win.waitForSelector("#app-loaded", { timeout: 20_000 });
    expect(refreshGrants(), "nothing renewed yet").toBe(0);
  });

  test("invalid_grant drops the credential and lands on the sign-in screen with the reason", async () => {
    await expect.poll(refreshGrants, { timeout: RENEW_AFTER_MS + 30_000 }).toBeGreaterThan(0);

    await expect
      .poll(() => revokedShell!.app.windows().some((p) => p.url().endsWith("/signin.html")), { timeout: 20_000 })
      .toBe(true);
    revokedShell!.win = revokedShell!.app.windows().find((p) => p.url().endsWith("/signin.html"))!;
    await revokedShell!.win.waitForSelector("#signin:not([hidden])", { timeout: 15_000 });
    await expect(revokedShell!.win.locator("#error")).toContainText("Sign in again");

    await expect
      .poll(
        () => {
          try {
            return !!JSON.parse(fs.readFileSync(credsFile, "utf8")).credentials?.[revokedId];
          } catch {
            return false;
          }
        },
        { message: "the revoked credential was removed from disk", timeout: 15_000 },
      )
      .toBe(false);
    expect(revokedShell!.log.some((l) => l.includes("the provider revoked the sign-in for Revoked stub"))).toBe(true);
  });

  test("the dead refresh token is never sent again", async () => {
    // The loop in #477 retried every 5 seconds. Three of those intervals with
    // no further grant proves the retry is gone, not merely slowed.
    await new Promise((r) => setTimeout(r, 15_000));
    expect(refreshGrants(), "exactly one refresh attempt").toBe(1);
  });
});
