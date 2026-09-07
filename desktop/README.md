# Calandria desktop shell

`desktop/` is an Electron shell around the same local Calandria server: it
launches `server.js` and `pty-server.js` as sidecars and shows the app in a
window, so the app starts by double-clicking an icon instead of by opening a
terminal, running `npm start`, and typing a URL. It also tells you when a task
needs you, from the dock and the tray, whether or not the window is open. It
is its own npm package so Electron (~280 MB unpacked) never lands in the root
app's `node_modules`, the Docker image, or the ordinary `npm test` run. The
only things that exercise it are the label-gated `desktop` and `windows-desktop`
jobs in `.github/workflows/test.yml`, and the tag-triggered
`.github/workflows/release-desktop.yml`.

This file covers building, packaging, signing, publishing and testing the
shell. For the shipped feature set and per-platform behavior, see
[`docs/DESKTOP_APP.md`](../docs/DESKTOP_APP.md); for the full e2e test recipes
and known flakes, see [`docs/DESKTOP_E2E.md`](../docs/DESKTOP_E2E.md).

## Layout

| File | What it is |
|-|-|
| `supervisor.js` | All the process management: PATH repair, Node resolution, port selection, spawn, readiness polling (raced against the sidecars' own exits, so a boot that has already failed rejects in the first second with the child's reason instead of failing at the timeout with `fetch failed`), drain-then-kill. **No `require("electron")`.** This is the part that survives a change of shell, and the part that can be tested headlessly. |
| `instances.js` | The saved instance list (which server the window attaches to) and the version handshake. `local` is the pair of sidecars `supervisor.js` spawns; a `url` entry is an origin the shell attaches to over the network; an `ssh` entry is one reached through a port forward (`ssh-tunnel.js`). Each in its own persistent Electron partition so an Access cookie cannot bleed between them. A `url` or `ssh` entry may also carry an `auth` block, validated by `instance-auth.js`'s `normalizeAuth` on every load and repair, which is what tells the window to offer sign-in instead of loading the instance's own login page. Holds the file at `~/.config/calandria/instances.json` (`CALANDRIA_INSTANCES_FILE` overrides) and repairs a hand-edited one instead of refusing to launch over it. No `require("electron")`. |
| `oauth.js` | The RFC 8252 sign-in flow a passkey or security key needs: OpenID Connect discovery, mandatory PKCE (S256), the authorize URL, a one-shot HTTP receiver on `127.0.0.1` that waits for the loopback redirect, and the authorization-code and refresh-token exchanges. No `require("electron")`; the caller injects `fetch`, which is how `main.js` drives it through the instance's own session. See [`docs/DESKTOP_APP.md`](../docs/DESKTOP_APP.md). |
| `instance-auth.js` | The credential model behind sign-in: `normalizeAuth` validates a saved or typed `auth` block (refusing a client secret outright, since this app is a public OAuth client with no place to keep one), `parseHeaderLines` turns a pasted `Name: value` textarea into the `header`-kind credential, and `authHeaders` turns either kind, or a stored OAuth token, into request headers. Persists `credentials.json` beside `instances.json`, encrypted with Electron's `safeStorage` where a keyring backs it and 0600 plain-with-a-logged-warning where none exists. No `require("electron")`. |
| `ssh-tunnel.js` | The `ssh` transport for a remote instance: `ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes -L 127.0.0.1:<local>:127.0.0.1:<remote> <host>`, the wait for the local port to accept, the message that tells a user to set up a key or a `ControlMaster` when ssh exits before it does, and the backoff that brings a dropped forward back on the **same** local port. Uses the user's own ssh binary, so their config, agent, jump hosts and hardware keys already work. No `require("electron")`. |
| `main.js` | Electron main: one window on the active instance (`instances.js`), an application menu and tray carrying the instance switcher, external links to the real browser, and quit-drains-first (held open, with a title and an on-page overlay, until the drain finishes). Also owns instance sign-in: `armAuthHeaders` stamps a configured instance's headers onto its own Electron session, and `signInToInstance` drives `oauth.js`'s flow in the user's real browser and renews a token before it expires. Closing the window **hides** it where the session is really drawing the tray icon and quits where it is not (`tray-residency.js`). No preload, no IPC, no `nodeIntegration`. |
| `instances.html` | The Add/Manage instances dialog, with a third mode for an instance's own sign-in settings (an `oauth` issuer/client-id/scope/redirect-port form, or the `header` textarea `parseHeaderLines` reads). A static document whose CSP forbids its own scripts, like `loading.html`; `main.js` injects the behavior with `executeJavaScript`. |
| `signin.html` | The in-app sign-in screen for an instance with a configured `auth` block: a spinner, "Sign in with your browser" / "Set up sign-in…" buttons, and the authorize URL as selectable text for when the system browser doesn't open on its own. A static document like `loading.html` and `instances.html`; `main.js` injects its behavior the same way. |
| `env-file.js` | The desktop app's one launch-time env source: a Finder/Dock/Login-Item launch hands `main.js` launchd's own minimal environment with nothing sourced, so this parses a plain `KEY=VALUE` file (default `~/.config/calandria/env`, `CALANDRIA_ENV_FILE` overrides; `XDG_CONFIG_HOME` respected) before either sidecar spawns. Deliberately dumb: no `$VAR` expansion, no command substitution, no sourced files. For real shell semantics, point `CALANDRIA_ENV_FILE` at a script and source it yourself first. |
| `notifier.js` | The notification/badge policy: a reconnecting subscription to the app's own `GET /api/events`, the instance-wide "needs you" sum behind the dock badge, and the one rule that decides whether a toast would be redundant. Renders payloads the **server** composed (`lib/notifications/notify.ts`); it does not invent notifications. Electron-free. |
| `assets/` | Committed tray and taskbar-badge PNGs. `scripts/make-assets.py` regenerates them (needs ImageMagick and a font). |
| `tray-residency.js` | Whether a status area is really drawing the tray icon, a question `new Tray()` cannot answer, since on Linux the constructor succeeds whether or not the item ever reaches a status-notifier host. Asks the session over `gdbus`/`dbus-send`, three-valued (yes/no/could-not-ask); the close handler consults this instead of `tray` being truthy. Electron-free. |
| `updater.js` | The auto-update policy: which installs may update themselves, what the menu item says, what the restart prompt admits it will interrupt, and the predicate the drain consults before it installs anything. Electron-free and pure; `main.js` owns every effect, including the `electron-updater` handle itself. See "Signing and publishing" below. |
| `loading.html` | Boot screen: a spinner, and a hint that appears on its own after 12s so a long first launch doesn't read as a hang. Also the unreachable-instance state (error plus Retry/Switch) and, for an `ssh` instance, the reconnecting state carrying ssh's last stderr lines. `main.js` pushes sidecar log lines into its off-screen `#log`, the only surviving copy of the supervisor's first lines (`desktop/e2e/` reads them back). |
| `test-supervisor.js` | The headless test suite: `supervisor.js`, `notifier.js`, `tray-residency.js`, `updater.js`, `instances.js`, `ssh-tunnel.js` (the last against `stub-ssh.js`), `oauth.js` (discovery, PKCE, the loopback receiver against a real socket, code/refresh exchange, no browser needed) and `instance-auth.js` (`normalizeAuth`, header-line parsing, the `credentials.json` round trip), plus source checks on `main.js`'s wiring: that an update installs only from inside the drain, that `SERVICE_TOKEN` has exactly one reader and it refuses any non-`local` instance, and that every main-process request goes through the instance's session. No deps, no display. |
| `test-real-boot.js` | Boots the actual `server.js` + `pty-server.js` through the supervisor against a throwaway database. Needs a build. |
| `e2e/` | The window layer, driven by Playwright's Electron driver under a virtual display, through its own config (`playwright.desktop.config.ts`, not the browser suite's). See "Testing" below and `docs/DESKTOP_E2E.md` for the full spec inventory and run recipes. |
| `stub-ssh.js` | A fake `ssh` for the tests: it really forwards (a TCP proxy across the `-L` argument), and `STUB_SSH_PLAN` scripts misbehavior a real sshd can't be asked for on demand (refuse the key, come up and drop, connect and never listen). |
| `stub-server.js`, `stub-pty.js` | Fake sidecars for the tests: readiness, drain-on-SIGTERM, a `POST /api/instance/drain` route that appends to `STUB_DRAIN_LOG` (with a `drain-hang` mode that never answers), and the unhappy paths (never ready, lock held, ignores SIGTERM). The stub server also echoes the env it was handed (`NODE_ENV`, `SHELL`, `argv[0]`, its ppid). |
| `scripts/build-payload.js` | Stages the production server payload for packaging. See "Packaging" below. |
| `scripts/fetch-node.js` | Downloads and verifies the vendored Node runtime. See "The bundled Node" below. |
| `scripts/notarize-dmg.js` | electron-builder's `artifactBuildCompleted` hook: notarizes and staples the `.dmg` itself (electron-builder's own notarization only covers the `.app`). See "Signing and publishing" below. |
| `electron-builder.cjs` | The packaging config. Lives here, not in `package.json`'s `build` field, because signing has to be decided at build time. |
| `signing.js` | The signing policy: which env vars mean "sign", validated all-or-nothing per platform. See "Signing and publishing" below. |

## Running it in dev

```bash
npm ci && npm run build          # in the repo root; the shell serves a prod build
cd desktop && npm install        # Electron only, ~280 MB, gitignored
npm start
```

The window shows a boot log until the server answers `/api/version`, then loads
the app. Quitting drains in-flight turns before exiting (`/api/instance/drain`
→ SIGTERM); closing the window is that same quit, so it stays on screen with a
"finishing in-flight turns…" overlay until the drain is done.

**On Linux, `npm start` needs `-- --no-sandbox`**, or a one-time
`sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod
4755` on that same file. npm unpacks Electron as you, so its setuid sandbox
helper isn't root-owned, and Chromium aborts (`FATAL: The SUID sandbox helper
binary was found, but is not configured correctly`, then SIGTRAP) instead of
running unsandboxed. A packaged install has none of this: the `.deb`'s postinst
sets the bit. `e2e/fixtures.ts` adds `--no-sandbox` itself for the test suite.

Env it understands:

| Var | Effect |
|-|-|
| `CALANDRIA_NODE` | Node binary the sidecars run under. Set this if `node` isn't on the GUI PATH. |
| `CALANDRIA_REPO_ROOT` | Repo to launch. Defaults to the parent of `desktop/` when run unpackaged, or to the bundled `app-payload` when packaged. This var wins over both, which is how a packaged binary gets pointed at a working checkout instead. |
| `CALANDRIA_READY_TIMEOUT_MS` | How long to wait for the first `/api/version` (default 90s). Only ever paid by a sidecar that is alive and silent; one that exits during boot fails `start()` immediately. |
| `PORT` / `PTY_PORT` | Preferred ports for the two sidecars. Taken ones are stepped past, not fought over. |
| `CALANDRIA_DB_DIR` | Which database to open. The shell doesn't read it itself: it reaches the sidecars by ordinary env inheritance, like the rest of the app's config. Same for its legacy alias `ORCH_DB_DIR`. |
| `CALANDRIA_ENV_FILE` | Overrides the default `~/.config/calandria/env` path `env-file.js` reads before either sidecar spawns. |

Everything else is the app's own config (`.env`, `lib/config.ts`) and is
inherited unchanged.

## Packaging

```bash
cd desktop
npm install
npm run dist:dir      # → dist/linux-unpacked/calandria-desktop
npm run dist:linux    # dist:dir, plus deb and AppImage targets
npm run dist:mac      # → dist/mac(-arm64)/Calandria.app, plus .dmg and .zip
npm run dist:win      # → dist/Calandria Setup <version>.exe, plus a zip
```

`dist:mac` builds all three of `mac.target`. `dir` is the unpacked bundle the
test suite launches and the only form the launchd spec can `open`; `dmg` is
the download people expect; `zip` is the one Squirrel.Mac needs: `electron-updater`
updates from the `.zip` on macOS, and a dmg-only build emits no
`latest-mac.yml` at all. `dist:win` builds `nsis` (a wizard, `oneClick: false`,
installs per-user with `perMachine: false` so no UAC prompt, directory
choosable) and `zip` for anyone who'd rather unpack a folder than run an
installer.

`dist:dir` runs `scripts/build-payload.js` (the `payload` script) before
handing off to electron-builder:

1. Runs `npm run build` in the repo root if there's no `.next` there yet
   (`--no-build` refuses instead, for a CI step that already built).
2. Installs a fresh, production-only `node_modules` with `npm ci --omit=dev`
   into a staging dir (`desktop/payload`), not copied from this checkout,
   whose `node_modules` carries the whole dev toolchain.
3. Deletes the files that existed only to make step 2 work
   (`package-lock.json`, `.npmrc`, `scripts/fix-pty.js`). The lockfile isn't
   inert: Next walks up looking for one to infer a workspace root and warns on
   every boot when it finds more than one.
4. Sweeps two classes of package out of that fresh tree, printing every
   deleted package with its size in the build log:
   - **Packages built for the wrong libc.** npm's lockfile records `os`/`cpu`
     per platform-optional dependency but never `libc`, so `npm ci` installs
     both the glibc and musl variant of anything scoped that way (e.g. both
     `@anthropic-ai/claude-agent-sdk-linux-x64-musl` and its glibc twin, plus
     two musl `sharp` packages). The sweep reads each staged package's own
     `libc` declaration (npm's matching rules, `!` negation included) instead
     of pattern-matching on `-musl`, so a newly added dependency is covered
     automatically. It keys off the **build target**, not the host
     (`--libc=musl` is for an Alpine-targeted build); on macOS and Windows,
     where there's no libc axis, it reports finding nothing instead of
     staying silent. Doing this at the `npm ci` layer doesn't work:
     `--omit=optional` drops the variant you need along with the one you
     don't, and `--libc=glibc` installs all four musl packages anyway because
     the lockfile has no `libc` field to filter on.
   - **`@next/swc`**, a build-time compiler a finished `next build` served by
     `next start` doesn't need, *unless* `next.config.mjs` sets
     `experimental.useLightningcss`; the build script checks for that flag
     first and keeps the compiler if it finds it.
   - **Not prunable**: `@openai/codex-linux-x64` declares no `libc` and has no
     twin: it ships one statically linked `x86_64-unknown-linux-musl` binary
     that runs on glibc systems fine.
5. Copies `.next` (minus `.next/cache`, which is `next build` scratch nothing
   reads at runtime), plus `server.js`, `pty-server.js`, `next.config.mjs`,
   `package.json`, and every plain-Node `.mjs` the two entrypoints
   dynamic-import. That file list lives in `desktop/payload-manifest.js` and
   is the SAME inventory the Dockerfile's runtime stage `COPY`s.
   `tests/desktopPayload.test.ts` fails the suite if the two drift, so a new
   `.mjs` import goes into both places.
6. Downloads and vendors a Node runtime (`scripts/fetch-node.js`; see "The
   bundled Node" below).
7. Runs the vendored Node against the staged tree with
   `require('better-sqlite3'); require('node-pty')`, so an ABI mismatch fails
   the build instead of the app's first query.

Packaged layout:

| Path | What it is |
|-|-|
| `resources/app.asar` | The Electron shell: `main.js`, `supervisor.js`, `notifier.js`, `tray-residency.js`, `loading.html`. |
| `resources/app-payload/` | The server payload from step 3 above. `extraResources`, **not** inside the asar: it holds native addons that `dlopen` from a real path and is spawned as a child process, and a child can't read out of an archive. |
| `resources/node/bin/node` | The Node the sidecars are spawned under. |

One `electron-builder` trap is worth knowing before editing the `build`
block: a single `{from: "payload", to: "app-payload"}` entry copies everything
**except** `node_modules`, silently: electron-builder manages app
dependencies itself and filters that name out of `extraResources`. The
packaged app looks complete and dies at first boot on an unresolved `next`.
The second, explicit `payload/node_modules` entry in `electron-builder.cjs` is
what actually carries it.

The electron-builder config lives in `desktop/electron-builder.cjs`, not
`package.json`'s `build` field, because signing decisions have to happen at
build time. Two traps come with that split, both pinned by
`tests/desktopSigning.test.ts`: a `build` key in `package.json` would shadow
the standalone file entirely (`app-builder-lib` reads `package.json` first and
only looks for a standalone config when that field is absent), and the loader
only scans for `electron-builder` + `.yml`/`.yaml`/`.json`/`.json5`/`.toml`/`.js`/`.cjs`/`.ts`.
`electron-builder.config.cjs`, the name most projects use, is not on that list
and would be silently ignored.

Also: electron-builder 26.15.3 warns on every Linux build that `desktopName`
is unset, then **rejects** `desktopName` as an unknown key if you set it. The
option its own warning names isn't in that version's schema. Don't chase it;
`syncDesktopName: true` is set instead and the warning is noise. The Linux
icon and `.desktop` entry come from the app's own PWA icon
(`public/icons/icon-512.png`).

### The bundled Node

`resolveNode()` in `supervisor.js` prefers `<resourcesPath>/node/bin/node`.
Two reasons: a double-clicked app must not depend on the PATH it was launched
with (on macOS that's launchd's stub, see `docs/DESKTOP_APP.md`'s Known
limitations section), and it
pins the ABI so a payload installed under one Node major isn't run under
whatever the user happens to have.

The vendored version defaults to the **host's own** `node --version` (the
same one that ran `npm ci` for the payload), so runtime and prebuild match by
construction. `CALANDRIA_DESKTOP_NODE_VERSION` overrides it for a
reproducible, pinned CI build. The download is verified against the official
`SHASUMS256.txt` before it's unpacked; only the `node` binary is taken, not
`npm` or the headers.

Native modules are never rebuilt against Electron's ABI: `npmRebuild: false`
and `nodeGypRebuild: false` stay set in `electron-builder.cjs`, since the
addons are only ever loaded by the bundled Node, never by Electron.

### Prerequisites

- `tar` and `xz` on PATH (Linux/macOS) to unpack the downloaded Node tarball;
  Windows uses `Expand-Archive` instead.
- Network access to `nodejs.org/dist` (or `CALANDRIA_DESKTOP_NODE_MIRROR`) the
  first time a given Node version is vendored; a version already present under
  `desktop/vendor/node` is reused.

`desktop/payload/`, `desktop/vendor/` and `desktop/dist/` are build
intermediates and gitignored. Delete them freely; they're regenerated.

## Signing and publishing

Signing is **opt-in by name**, never by the presence of a secret: a
half-configured request raises an error instead of silently downgrading to
unsigned. `desktop/signing.js` holds the policy and `tests/desktopSigning.test.ts`
drives every branch of it. No CI lane in `test.yml` sets any signing
variables, and none should. `macos-desktop` deliberately signs ad-hoc and
asserts Gatekeeper *refuses* the result, so a certificate leaking into a
PR-triggered build would be caught instead of used silently.
`.github/workflows/verify-signing-credentials.yml` is the on-demand check
that the real macOS signing secrets are valid, without doing a full build.

### macOS

All three mac targets are **ad-hoc signed by default**: arm64 macOS refuses to
`exec` a Mach-O carrying no signature at all, and electron-builder invalidates
the signature Electron's prebuilt arrived with. `mac.identity: "-"` in
`electron-builder.cjs` is electron-builder's own ad-hoc path, applied *during*
the build, before `dmg`/`zip` are cut from the bundle. A `codesign` run
afterward would never reach the installers. Hardened runtime is on in both the
ad-hoc and Developer ID cases; the difference is the entitlements file:
`build/entitlements.mac.adhoc.plist` carries
`com.apple.security.cs.disable-library-validation` (an identity-less
signature has no Team ID for library validation to match against the vendored
Node and native addons it needs to `dlopen`); `build/entitlements.mac.plist`
(Developer ID) deliberately does not: if a signed build ever needs that
entitlement to start, something in the payload was signed by the wrong
identity.

**A postinstall patch is currently required for any of this to sign at all.**
`desktop/scripts/patch-electron-builder-keychain.js`, run from `desktop`'s own
`postinstall`, rewrites three lines in the installed `app-builder-lib` copy:
its `createKeychain()` never passes its own keychain-unlock password into
`importCerts()`, so `security set-key-partition-list -k` receives the `.p12`
import password instead. That went unnoticed while macOS ignored `-k` on an
already-unlocked keychain; a current macOS runner image enforces it and fails
every build with `security: SecKeychainUnlock: The user name or passphrase
you entered is not correct.` No released electron-builder carries the fix yet
(upstream [electron-userland/electron-builder#10101](https://github.com/electron-userland/electron-builder/pull/10101)
merged only to the v27 alpha line; a v26 backport is merged but unpublished on
npm). The patch matches each line against a string re-verified unique on
every run, so a partial application can't happen silently, and retires itself
once it detects the already-fixed shape. It hard-fails only on macOS, where
signing happens; elsewhere it warns and continues so an unrelated upstream
restructure can't take down Linux or Windows builds too.

An ad-hoc signature is not distributable: a `.app` downloaded from the
internet is quarantine-tagged, and Gatekeeper refuses it with *"Calandria is
damaged and can't be opened,"* which is not a corrupt download. Every install on a
machine that didn't build it needs:

```bash
# after dragging Calandria.app to /Applications
xattr -dr com.apple.quarantine /Applications/Calandria.app
```

or right-click → Open and confirm the dialog, on **every** such install. A
published release is Developer ID signed, notarized and stapled, and needs
none of this.

**Getting a Developer ID Application certificate.** Under *Certificates,
Identifiers & Profiles → Certificates → + → Software*, pick **Developer ID
Application**: not *Developer ID Installer* (signs `.pkg`, unused here), not
*Apple Development*/*Apple Distribution* (Xcode/App Store only; Gatekeeper
won't accept them for a direct download). No Mac is required: a CSR is a
plain PKCS#10 request, and OpenSSL on Linux or Windows does the whole round
trip.

```bash
# 1. Key and CSR. Apple requires RSA 2048; the email should be the Apple ID.
openssl genrsa -out devid.key 2048
openssl req -new -key devid.key -out devid.certSigningRequest \
  -subj "/emailAddress=you@example.com/CN=Your Name/C=US"

# 2. Upload devid.certSigningRequest, pick Developer ID Application, download
#    the .cer. It contains only the certificate; the private key never left here.
openssl x509 -inform DER -in developerID_application.cer -out devid.pem

# 3. The intermediates, WITHOUT WHICH THIS SILENTLY FAILS.
#    Both, not one: Apple runs two Developer ID CAs and you should not have to
#    know which signed yours.
curl -O https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer   # G2, to 2031
curl -O https://www.apple.com/certificateauthority/DeveloperIDCA.cer     # G1, to 2027
openssl x509 -inform DER -in DeveloperIDG2CA.cer  > apple-intermediates.pem
openssl x509 -inform DER -in DeveloperIDCA.cer   >> apple-intermediates.pem

# 4. Bundle key + leaf + intermediates. -legacy is not optional on OpenSSL 3.
#    It prompts twice for an export password: that is CSC_KEY_PASSWORD, and it
#    should not be blank.
openssl pkcs12 -export -legacy -out devid.p12 \
  -inkey devid.key -in devid.pem -certfile apple-intermediates.pem

# 5. CSC_LINK, and the identity string.
base64 -w0 devid.p12 > devid.p12.base64
openssl x509 -in devid.pem -noout -subject   # CN= is CALANDRIA_MAC_SIGN_IDENTITY
```

On Windows, the OpenSSL that ships with Git Bash or WSL runs all of that
unchanged, except there's no `base64 -w0`; use PowerShell:
`[Convert]::ToBase64String([IO.File]::ReadAllBytes('devid.p12'))`. On a Mac,
`base64 -i devid.p12`.

Two failure modes produce a build that imports the certificate happily and
then reports no identity at all: a `.p12` missing the issuing intermediate
(step 3 above: without it, `security find-identity -v` can't build a chain to
a trusted root and drops the identity silently on a hosted runner); and
OpenSSL 3's default PKCS#12 encryption, which macOS's `security import`
doesn't read (`-legacy` in step 4 fixes it). Don't pass `-passout` on the
command line for the export password; let OpenSSL prompt, so it doesn't land
in shell history.

Env vars, all-or-nothing per platform:

| Variable | What it is |
|-|-|
| `CALANDRIA_MAC_SIGN_IDENTITY` | The Developer ID Application certificate name, **with** the `Developer ID Application: ` prefix (`desktop/signing.js` strips it before handing it to electron-builder, which rejects the prefix itself). Unset or `-` means ad-hoc; this is the only switch. |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | The `.p12` electron-builder imports into a temporary keychain, base64-encoded, and its password. |
| `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | An App Store Connect **Team** key (not an Individual key: those can't use `notarytool`), from *Users and Access → Integrations → App Store Connect API → Team Keys*. `APPLE_API_KEY` is a **file path**, not the key contents; `APPLE_API_KEY_P8` is the CI secret holding the `.p8` contents, written to that path before the build runs. The `.p8` downloads exactly once; Apple keeps no copy. |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | The fallback if the API key route is blocked (app-specific password from account.apple.com → Sign-In and Security). Worse: tied to the account, invalidated on password change. |
| `CALANDRIA_MAC_SKIP_NOTARIZE=1` | Sign without notarizing, for testing signing alone. The result must not be published. |

Setting the identity with no notarization credentials **fails the build**:
a Developer ID signature without notarization is still refused on a
downloaded copy, so that combination would look signed and behave unsigned.

**electron-builder skips macOS signing outright on pull-request builds**
(`isSignAllowed()` treats a set `GITHUB_BASE_REF` as "this is a PR"). The
packaging step works around it by unsetting `GITHUB_BASE_REF` in the shell
(not in a step's `env:` map: GitHub Actions drops any assignment to a
`GITHUB_`-prefixed variable when building the process environment, so setting
it there only makes the log lie about what ran). That re-enables signing, not
signing-with-a-certificate: `mac.identity: "-"` still wins over anything a
`CSC_LINK` import put in the keychain.

Notarization happens twice, on two different artifacts: electron-builder
notarizes and staples **the `.app`** from inside `MacPackager.sign()`, so the
`.dmg` and `.zip` are cut from an already-stapled bundle; and
`desktop/scripts/notarize-dmg.js`, wired in as electron-builder's
`artifactBuildCompleted` hook (not `afterAllArtifactBuild`, which would race a
`--publish` run that's already uploading un-stapled bytes), notarizes and
staples **the `.dmg` itself**: the disk image is its own notarizable
container and is what the browser quarantine-tags. The `.zip` is left alone:
nowhere to hold a ticket, and the app inside is already stapled.

Verify with:

```bash
codesign --verify --deep --strict Calandria.app   # passes even on an ad-hoc bundle
spctl --assess --type execute -vvv Calandria.app  # must ACCEPT for a real release
xcrun stapler validate Calandria.app               # and on the .dmg too
```

Only a real browser download (not `curl`, not `scp`) produces the quarantine
attribute, so only that reproduces what a user actually gets.

### Windows

Azure Artifact Signing, configured by four non-secret variables: all four or
none, three of four throws:

| Variable | What it is |
|-|-|
| `AZURE_CODE_SIGNING_ENDPOINT` | Regional endpoint, e.g. `https://eus.codesigning.azure.net/`. |
| `AZURE_CODE_SIGNING_ACCOUNT_NAME` | The signing account. |
| `AZURE_CODE_SIGNING_CERT_PROFILE_NAME` | The certificate profile inside it. |
| `AZURE_CODE_SIGNING_PUBLISHER_NAME` | The subject the signature must match, e.g. `CN=…, O=…, C=US`. |

electron-builder switches from `signtool` to `WindowsSignAzureManager` on the
presence of `win.azureSignOptions` alone. Authentication is Entra ID's
ambient credential chain: on GitHub Actions, OIDC workload-identity
federation via `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and the token file
`azure/login` writes. There's no certificate and no secret to store.

Without all four variables, electron-builder finds nothing to sign with and
produces an unsigned artifact instead of failing. The SmartScreen cost of
that is real: a MotW-marked, unsigned `.exe` or extracted `.zip` raises a
full-screen *"Windows protected your PC"* dialog (past it: **More info** →
**Run anyway**), and it re-earns that warning from zero on every release for
as long as the artifacts stay unsigned. A locally built installer never shows
it, since a file that was never downloaded carries no mark, which is also
why no CI lane can observe it.

### The release lane

`.github/workflows/release-desktop.yml` is what puts a binary in anybody's
hands; everything above is for building one yourself or proving CI can. It
runs on the `v*` tag release-please cuts, three runners in parallel, each
building and publishing its own platform's targets straight to the GitHub
Release, plus one `SHA256SUMS.txt` covering all of them.

The upload is **electron-builder's own** `github` publish provider
(`--publish always`), not a `gh release upload` step: the provider is what
writes the update feed (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`,
plus `.blockmap` files for differential downloads) beside each artifact as it
goes. Hand-uploading would produce every artifact and no feed, which is an
updater that silently never finds anything.

`desktop/package.json`'s `version` is the tag the publisher looks the Release
up by; release-please rewrites it on every bump via `extra-files` in
`release-please-config.json`, and `tests/desktopRelease.test.ts` fails if it
drifts. A stale version doesn't error; it quietly uploads everything into an
unseen draft release. The vendored Node is pinned for a release with
`CALANDRIA_DESKTOP_NODE_VERSION` instead of taking the runner's, so two
releases a week apart ship the same runtime.

A dry run (`gh workflow run release-desktop.yml --ref <ref>`, `publish` left
unticked) builds, signs, notarizes, staples and runs every assertion without
publishing, attaching the installers to the run as downloadable workflow
artifacts. It's the only way to exercise the signed path before a tag exists,
since no pull-request lane has the real signing secrets.

`SHA256SUMS.txt` is generated by matching each built installer's filename
against the release's actual asset list, normalizing every non-alphanumeric
character in a name to the same placeholder on both sides before comparing,
and failing the job if a name matches zero or more than one asset. This
replaced a manifest that named a spaced `Calandria Setup <version>.exe` while
GitHub served the hyphenated `Calandria-Setup-<version>.exe`, which made
`sha256sum -c` either report the file missing or, with `--ignore-missing`,
report success having verified nothing.

The generated release notes name a platform only when that platform's build
leg actually produced an artifact; a leg that failed is named as absent
instead of being described as present or silently left out.

### What signing costs

Re-checked 2026-08-29.

| Item | Cost |
|-|-|
| Apple Developer Program + notarization | $99/yr, paid. An individual membership is enough and grants up to five Developer ID Application certificates; notarization is included. |
| Windows code signing | Azure Artifact Signing, $9.99/month (Basic, 5,000 signatures/month), not yet purchased. |
| Auto-update | Free once signing is in place: `electron-updater` reads the feed the release lane already writes. Windows and Linux AppImage work as-is; macOS needs the $99 above, since Squirrel.Mac refuses to install into an unsigned build. |

**EV is not worth the premium on Windows.** Microsoft's Trusted Root Program
removed EV's automatic SmartScreen reputation in March 2024; its own
documentation now says paying extra for EV solely to dodge SmartScreen
warnings isn't justified. Azure Artifact Signing (non-EV, $9.99/mo, no
certificate or secret to guard, since authentication is OIDC) produces the
identical SmartScreen outcome to a traditional OV certificate, which by
comparison runs closer to $369/yr once you add the FIPS 140-2 Level 2 cloud
HSM subscription a June 2023 CA/Browser Forum rule now requires. Take Azure.

**On macOS the $99 is the price of the auto-update feature, not a premium**:
an unsigned or ad-hoc-signed app cannot self-update at all. Squirrel.Mac
verifies the downloaded bundle's signature before installing. Windows and
Linux degrade gracefully without signing (a warning, an unverified package);
macOS simply doesn't function.

Linux costs nothing to enroll with; publishing SHA-256 checksums beside the
artifacts is the whole convention.

## Updates

The shell checks the feed the release lane publishes 45 seconds after boot
and every six hours after that. Downloading is automatic; **installing never
is**. A ready update announces itself as an OS notification and as a
tray/menu item labelled `Restart to update to <version>`, not a dialog, since
the window is usually hidden to the tray. `Check for updates…` sits in both
the tray menu and the View menu, from one shared function.

**The restart goes through the drain, and that is the whole point.**
`electron-updater`'s `autoInstallOnAppQuit` default installs from
`app.on("quit")`, which fires after `before-quit` has already drained and
exited, so the default would either skip the install or run it over turns
still settling. It is off. `main.js`'s `finishQuit()` calls
`quitAndInstall()` as the last statement of the drain instead, only when the
user asked and something is downloaded. `tests/desktopUpdater.test.ts` and
`test-supervisor.js` pin that, including that `finishQuit` is the file's only
install call site.

Not every install can update itself; the ones that can't say so in the menu
instead of failing oddly:

| | Updates? |
|-|-|
| Windows NSIS | Yes, signed or not |
| macOS | **Only when signed, and only from `/Applications`.** Squirrel.Mac refuses an app whose signature it can't read, so an ad-hoc build (every local `dist:mac`, every install from before 2026-08-30) has no update path at all; decided at boot from `codesign`, so the menu says `Updates need a manual download` before the first check. Running from the mounted DMG or a translocated path is refused the same way. |
| Linux AppImage | Yes (detected by `process.env.APPIMAGE`) |
| Linux `.deb` | No, deliberately: it's your package manager's to replace, and `electron-updater`'s deb path is an unverified `sudo dpkg -i` |
| `npm start` | No: a dev build updates by `git pull` |

On macOS the install itself happens after `quitAndInstall()`: that call
hands the zip to Squirrel.Mac, which fetches, unpacks and verifies the
bundle before it quits the app. The drain's tail waits on Squirrel's own
progress events for that (ten minutes while it's demonstrably working,
thirty seconds while it's said nothing) instead of a fixed timeout that
could exit over the top of it and relaunch the old build. An install that
still fails is written down and reported on the next launch, with the log
path.

Logs: `~/Library/Logs/Calandria/main.log` on macOS,
`~/.config/Calandria/logs/main.log` on Linux,
`%APPDATA%\Calandria\logs\main.log` on Windows. Everything the shell prints
goes there too, including the updater's own debug trace.

`CALANDRIA_DESKTOP_AUTO_UPDATE=off` stops the shell contacting the feed at
all.

`electron-updater` and `electron-log` are this package's two **runtime**
dependencies. They're packed because they're in `dependencies`, not because
`electron-builder.cjs`'s `files` names them (that list can't carry
`node_modules`), so moving either to `devDependencies` would ship a shell
that throws on the require.

## Testing

```bash
npm run desktop:install         # Electron, once (see the NODE_ENV note below)
npm run build                   # the shell serves a production build

npm run test:desktop:supervisor # headless, ~8s, no display
npm run test:desktop:boot       # boots the real server.js/pty-server.js
xvfb-run -a npm run test:desktop:window   # the window suite; needs a display
xvfb-run -a npm run test:desktop          # all three, in that order
```

All three run from the **repo root**; CI runs exactly these (the `desktop` job
and `windows-desktop` job in `.github/workflows/test.yml`). `desktop/e2e/`
drives its window suite through its own config, `playwright.desktop.config.ts`,
not the browser suite's config, since the point here is that the shell
boots the server itself.

Electron is a `devDependency`, so `npm install` under `NODE_ENV=production`
(which a Calandria task session exports) reports "up to date" and installs
nothing. Use `NODE_ENV=development npm install`; if `node_modules/electron/dist/`
is still missing, `node node_modules/electron/install.js` fetches the binary.

A few env vars gate what the window suite runs against:

| Var | Effect |
|-|-|
| `CALANDRIA_TEST_BIN` | Runs the window suite against a packaged binary instead of the dev shell. `e2e/fixtures.ts` refuses to launch a binary under the repo checkout, and drops any inherited `CALANDRIA_REPO_ROOT` so the packaged app has to resolve its own bundled payload. |
| `CALANDRIA_DESKTOP_SANDBOX=1` | For a real installed package: keeps `--no-sandbox` off AND sets `chromiumSandbox: true` on `electron.launch()` (Playwright otherwise unshifts `--no-sandbox` on Linux by default). |
| `CALANDRIA_TEST_APP_BUNDLE` | macOS only: points at the `.app` bundle itself (not the binary inside), for the launchd-launch spec that needs to `open` it through LaunchServices. |
| `CALANDRIA_DESKTOP_BENCH=1` | Gates three native-integration specs (tray registration, OS notifications, window-manager behavior) that only mean anything on a machine with a real logged-in desktop session. |

See `docs/DESKTOP_E2E.md` for the full per-platform packaged-testing recipes
(unpacked/installed Linux, macOS dist+codesign+dmg verification, the Windows
installer round trip), the bench-VM access and gotchas, and the current flake
list.

## The one rule

**The server runs under a real `node`, never inside Electron.** Two reasons,
both measured in `docs/DESKTOP_APP.md`: `better-sqlite3`'s prebuild will not
load into Electron's V8 ABI, and `lib/agents/codex/driver.ts` spawns the MCP
tool bridge as `process.execPath scripts/calandria-mcp.mjs` with a closed env.
Hosting the server inside Electron would turn that spawn into a GUI process on
every Codex turn instead of the bridge.

`supervisor.js` enforces this: it refuses an Electron binary as the runtime
and strips every `ELECTRON_*` variable out of the sidecar environment, so
nothing the server spawns downstream (agent CLIs, MCP bridges, your login
shell in the terminal panel) inherits Electron's runtime flags.
