Status: draft
Product paths: `lib/updates/`, `app/api/updates/`, `app/shell/UpdatePill.tsx`, `app/shell/useUpdates.ts`, `app/shell/SettingsView.tsx`, `app/Shell.tsx`, `lib/events.ts`, `app/api/settings/route.ts`, `app/api/instance/scheduler/route.ts`, `desktop/main.js`, `desktop/updater.js`, `Dockerfile`, `lib/env.mjs`, `.env.example`, `docs/SELF_HOSTING.md`, `docs/DESKTOP_APP.md`

# Update notifications design

Date: 2026-09-08

Calandria has no update notification. The web app has no version display and no update check. The desktop app checks GitHub releases every six hours, but the only place the result shows is a menu item in the tray and the View menu. This design adds one indicator in the titlebar of every Calandria window, a popover behind it that shows the release notes, and an action that fits how the instance was installed.

Code facts below are from the product repo at origin/main, release 0.11.0.

## What exists today

- `GET /api/version` returns `{ sha, builtAt, version, instanceName }`. `sha` and `builtAt` come from `CALANDRIA_GIT_SHA` and `CALANDRIA_BUILT_AT`, which the Dockerfile sets from build args and which read `unknown` everywhere else. `version` is `package.json`. The route is exempt from the origin auth gate because it is the Docker health check and the desktop handshake.
- Releases are cut by release-please. Every push to main updates a release PR; merging it tags `vX.Y.Z` and creates a GitHub release whose body is the changelog section for that version, followed by a `<!-- desktop-artifacts -->` marker and a table of desktop installers and their signing status. `release-desktop.yml` attaches the installers and the `latest*.yml` feeds. `publish-image.yml` pushes `ghcr.io/calandria-dev/calandria` with tags `latest`, `X.Y.Z`, `X.Y`, `edge` and `sha-<7>`. The repo is public, so the releases API needs no token.
- The desktop app (`desktop/main.js`, `desktop/updater.js`) runs electron-updater against the GitHub provider. First check 45 seconds after boot, then every six hours. Phases are `idle`, `checking`, `downloading`, `ready` and `error`, held in a module variable that only the tray and app menus read. `updaterDisposition()` returns `{ enabled, code, reason }` with codes `off`, `unpackaged`, `linux-package`, `mac-dmg`, `mac-translocated`, `mac-unsigned` and `ok`. `requestInstall()` reads the active-turn count from `GET /api/instance/metrics`, shows a native dialog, and installs after the drain. The updater runs whether the active instance is local or remote, and updates the shell only.
- The renderer has no preload and no IPC. Main pushes into the page with `webContents.executeJavaScript`, which is how `calandria:goto-task` is dispatched today. `setWindowOpenHandler` and `will-navigate` intercept off-origin navigations. The user agent carries `Calandria-Desktop/<version>` and `isDesktopShell()` in `app/shell/useNotifications.ts` reads it.
- The titlebar right cluster in `app/Shell.tsx` holds the plan-usage pill, the "N NEED YOU" pill, the Services, Terminal and Appearance buttons, and the Insights and theme icons. Pills are 28px, mono 10.5px, 999px radius. Dropdowns use `Popover` from `app/shell/shared.tsx`.
- The boot self-ping to `POST /api/instance/scheduler` starts the server tickers (schedules, PR polling, deferred starts).
- Feature flags live in `lib/features.ts` and reach the client as `window.__FEATURES`. Settings are key-value rows in the `settings` table, written through `PATCH /api/settings` behind an allowlist regex.
- Docs tell container operators to back up, note the version from `/api/version`, then `docker compose pull` and `up -d --no-build` (`docs/SELF_HOSTING.md`, "Upgrading"). Source checkouts have no upgrade section. Desktop auto-update is documented in `docs/DESKTOP_APP.md`, under "Updates".

## Decisions

### 1. The server checks, once per instance

The check runs in the server process, in `lib/updates/`, on the same boot hook as the other tickers. One request per instance every six hours, plus one when you press "Check now". Browser tabs never call GitHub. The result is cached in memory and persisted in the `settings` table under `update_state`, so a restart does not fetch again and the first page load already shows the pill.

The request is `GET https://api.github.com/repos/calandria-dev/calandria/releases?per_page=20`, unauthenticated, with `User-Agent: calandria/<version>`, a 10 second timeout, and no other data about the instance. The check drops drafts and pre-releases. The newest remaining release is `latest`. It keeps every release newer than the running version, with its notes, so the popover shows what you skipped, not only the last step.

Opt-out is layered:

- `CALANDRIA_UPDATE_CHECK=off` turns the check off at the operator level, hides the pill, and hides the switch in Settings. Air-gapped hosts and forks set this.
- The `update_check` setting (default on, `off` disables) is the switch in Settings → General.
- `CALANDRIA_UPDATE_FEED_URL` replaces the releases URL. Tests point it at a fixture. A fork or a mirror can point it at its own feed.

A failed check keeps the previous result, records the error and the time, and shows nothing in the titlebar. Settings shows "Last check failed" with the error.

### 2. Install method is a server fact, the shell is a client fact

Two different things can be out of date: the server (the thing the page is served from) and the desktop shell (the Electron app around the page). The server reports how it was installed. The page works out what shell it is in.

| Server install method | Signal | Notes |
|-|-|-|
| `container` | `CALANDRIA_CONTAINER=1`, set by the Dockerfile, or `/.dockerenv` present | New env var. The Dockerfile sets it next to `CALANDRIA_GIT_SHA`. |
| `source` | `.git` (directory or file) at the server root | Packaged payloads and images omit `.git`, so a checkout run with `npm start` or `npm run dev` is the only case with one. |
| `bundled` | Neither of the above | The server the desktop supervisor spawns from its payload. |

Checked in that order. The page detects the shell from the user agent, as `isDesktopShell()` does today, and reads the shell version from the `Calandria-Desktop/<version>` token.

### 3. What each combination offers

| Server method | Shell | Pill shows | Action in the popover |
|-|-|-|-|
| `bundled` | desktop | The desktop updater's phase for the shell. The server is inside the shell, so there is one target. | Follows the updater: **Restart to update** when `ready`, progress while `downloading`, **Check now** when `idle`. When `disposition.enabled` is false the action is **Open release page** with the disposition reason under it. |
| `container` | browser | Server version behind latest. | No action button. **How to update** expands the three compose commands from `docs/SELF_HOSTING.md`, with the backup step first and a copy button. |
| `source` | browser | Server version behind latest. | No action button. **How to update** expands `git pull`, `npm ci`, `npm run build`, restart. |
| `container` or `source` | desktop, attached to a remote instance | Whichever of the two targets is behind. Both when both are. | Two blocks: the server block as above, and a **This app** block driven by the desktop updater. |
| any | browser, up to date | Hidden. | Settings → General still shows the version and the last check. |

The desktop app updates the shell only. Nothing in this design updates a server from a client, and nothing pulls an image or runs `git pull` from the app.

### 4. The desktop bridge

Main sends the updater's state to the page, and the page sends action requests to main, with no preload and no IPC:

- Main to page: every `setUpdateState()` call, and every `did-finish-load` of an app URL, runs `executeJavaScript` that dispatches `window.dispatchEvent(new CustomEvent("calandria:desktop-update", { detail }))`. `detail` is `{ shellVersion, phase, version, percent, disposition: { enabled, code, reason }, error }`. This mirrors `calandria:goto-task`.
- Page to main: the page calls `window.open("calandria-desktop://update/install")` or `window.open("calandria-desktop://update/check")`. `setWindowOpenHandler` (and `will-navigate`, for the same URLs) recognises the `calandria-desktop:` scheme, calls `requestInstall()` or `checkForUpdates(true)`, and returns `{ action: "deny" }`. The scheme is never registered with the OS.

The native "ready to install" dialog and the drain overlay stay as they are. The page's button is a second way to reach the same `requestInstall()`.

### 5. Release notes come from the GitHub release body

`lib/updates/notes.ts` cuts each body at `<!-- desktop-artifacts -->` and keeps the markdown above it, which is the release-please section: a version heading with a compare link, then `### Features` and `### Bug Fixes` lists whose items end in a commit link and, for merged PRs, an issue link. The client renders it with `app/Markdown.tsx`. The popover shows up to three releases expanded, newest first, and a **Show N more** control for the rest. For the newest release, the popover's own header replaces the version heading; older releases keep it as a sub-heading.

### 6. Dismissal is per instance, per version

**Skip this version** writes `update_dismissed=<version>` to settings. The pill hides until a version newer than the dismissed one appears. The Settings field says which version is skipped and offers **Show again**. The dismissal is instance-wide, like the rest of the settings table; a second browser on the same instance sees the same state.

### 7. Surfaces

**Titlebar pill.** In the right cluster, left of the plan-usage pill. Same construction as the existing pills: 28px tall, mono 10.5px, 999px radius. Accent tint (`--accent` on `--accent-soft`), which the titlebar does not use for any other pill, so it reads as new information rather than as trouble. Label states:

| State | Label | Tooltip |
|-|-|-|
| available | arrow-up glyph, then the version | "Calandria 0.12.0 is available" |
| desktop `checking` | "Checking…" | |
| desktop `downloading` | spinner, "Downloading 0.12.0" | |
| desktop `ready` | "Restart to update", accent fill | "0.12.0 is downloaded. Restart to install it." |
| desktop `error` | as available | the error, in the popover |

Mobile (`max-width: 760px`): a `tb-icon` with the arrow-up glyph and a 6px accent dot, since the labelled pill does not fit next to the terminal button.

**Popover.** `Popover` from `shared.tsx`, 400px wide, anchored to the pill. Header: "Calandria 0.12.0", then one line: "Released 8 September. This instance runs 0.11.0." with the instance name and install method when the instance is named or the shell is attached to a remote. Then the action block or blocks from decision 3, then the release notes from decision 5, then a footer with **Skip this version** and **Release page**, the latter opening `html_url` in a new tab (the desktop shell hands it to the OS browser as it does every off-origin link).

**Settings → General → Updates.** A field below the existing General fields:

- Version line, mono: `0.11.0 · 0b10f47 · built 8 Sep 2026 · container`, and the instance name when set. This is the version display the app lacks today.
- Switch **Check for updates**, help: "Asks github.com for the newest release every six hours. The request carries this instance's version and nothing else." Hidden when `CALANDRIA_UPDATE_CHECK=off`, replaced by "Update checks are off for this instance (`CALANDRIA_UPDATE_CHECK`)."
- **Check now** button with "Last checked 12 minutes ago · up to date", or "Last check failed: <error>", or "0.12.0 is available", the last one a link that opens the popover.
- When a version is skipped: "0.12.0 is skipped. Show again."

## API

`GET /api/updates`, behind the normal auth gate:

```json
{
  "enabled": true,
  "current": { "version": "0.11.0", "sha": "0b10f47", "builtAt": "2026-09-08T15:40:00Z", "installMethod": "container", "instanceName": "Lab" },
  "latest": { "version": "0.12.0", "tag": "v0.12.0", "url": "https://github.com/calandria-dev/calandria/releases/tag/v0.12.0", "publishedAt": "2026-09-15T10:02:11Z" },
  "available": true,
  "releases": [
    { "version": "0.12.0", "url": "…", "publishedAt": "…", "notes": "### Features\n\n* …" }
  ],
  "dismissedVersion": null,
  "checkedAt": "2026-09-15T12:00:00Z",
  "error": null
}
```

`latest` and `releases` are null and empty before the first successful check. `available` is `latest.version > current.version` and false for a source checkout whose `package.json` equals the latest tag, since a checkout of main between releases carries the last release's version.

`POST /api/updates/check` runs a check now and returns the same shape. One check in flight at a time; a second call while one runs awaits the same promise.

Settings keys added to the allowlist: `update_check`, `update_dismissed`. `update_state` is written by the server only and is not in the allowlist.

Global wire event `updates_changed`, no payload, published after every check that changes `latest`, `error` or `checkedAt`, and after every write to `update_dismissed` or `update_check`. The client refetches, as it does for `runbooks_changed`.

Env vars registered in `lib/env.mjs` and documented in `.env.example`: `CALANDRIA_UPDATE_CHECK`, `CALANDRIA_UPDATE_FEED_URL`, `CALANDRIA_CONTAINER`.

## Version comparison

Versions are `X.Y.Z` from release-please. `lib/updates/semver.ts` parses three integers and compares them; anything that fails to parse compares as older than everything, so a malformed feed never produces a pill. The shell version from the user agent is compared the same way against `latest.version`.

## Files

| File | Responsibility |
|-|-|
| `lib/updates/installMethod.ts` (create) | `detectInstallMethod(env, fs, root)`: container, source, bundled. |
| `lib/updates/semver.ts` (create) | `parseVersion`, `compareVersions`, `isNewer`. |
| `lib/updates/notes.ts` (create) | `trimReleaseNotes(body)`: cut at the artifacts marker, drop the version heading. |
| `lib/updates/check.ts` (create) | The checker: fetch, filter, cache, persist, ticker, `updates_changed`. |
| `app/api/updates/route.ts` (create) | `GET`, the state shape above. |
| `app/api/updates/check/route.ts` (create) | `POST`, check now. |
| `app/api/instance/scheduler/route.ts` (modify) | Starts the checker with the other tickers. |
| `app/api/settings/route.ts` (modify) | Allowlist `update_check`, `update_dismissed`; publish `updates_changed` on either. |
| `lib/events.ts` (modify) | `UpdatesChangedWireEvent` in `GlobalWireEvent`. |
| `app/shell/useGlobalEvents.ts` (modify) | Routes `updates_changed` to a refetch. |
| `app/shell/useUpdates.ts` (create) | Fetches `/api/updates`, listens for `calandria:desktop-update`, reads the shell version from the user agent, and exposes `targets()`. |
| `app/shell/updateTargets.ts` (create) | Pure: server state, shell state and install method in, the list of target blocks out. |
| `app/shell/UpdatePill.tsx` (create) | The pill, the mobile icon, and the popover. |
| `app/Shell.tsx` (modify) | Renders the pill in the right cluster. |
| `app/shell/SettingsView.tsx` (modify) | The Updates field in General. |
| `app/icons.tsx` (modify) | `arrowUp` glyph. |
| `app/globals.css` (modify) | `.update-pill`, `.update-menu` and the mobile icon dot. |
| `desktop/updater.js` (modify) | `pageUpdateState(state, disposition, shellVersion)` and `parseDesktopCommand(url)`, both pure. |
| `desktop/main.js` (modify) | Pushes the state on every transition and on load; handles `calandria-desktop:` in the two navigation hooks. |
| `Dockerfile` (modify) | `ENV CALANDRIA_CONTAINER=1`. |
| `lib/env.mjs`, `.env.example` (modify) | The three env vars. |
| `docs/SELF_HOSTING.md`, `docs/DESKTOP_APP.md` (modify) | The indicator, the opt-out, the source-checkout upgrade steps. |

## Out of scope

- Notifying about an update through the notifications system (web push, native toast). The desktop app already toasts when a download completes; the web app gets the pill only. A follow-up can add an `update_available` notification kind.
- Updating a container or a source checkout from the app.
- Updating a remote server from the desktop client.
- An `edge` channel or pre-release opt-in. The check follows tagged releases only.
- Showing the pill in the desktop instances page or the tray beyond the existing menu item.

## Risks and open points

- **Rate limits.** Unauthenticated GitHub API calls are limited per source IP to 60 an hour. One call per six hours per instance is far under that, but many instances behind one NAT share the budget. A failed check is silent in the titlebar, so the failure mode is a stale pill, not a broken app.
- **Proxies.** Node's `fetch` does not read `HTTPS_PROXY`. A host that can only reach GitHub through a proxy sees "Last check failed" and can set `CALANDRIA_UPDATE_CHECK=off` or point `CALANDRIA_UPDATE_FEED_URL` at a mirror. Documented, not solved here.
- **Forks.** A fork that keeps `package.json` at upstream's version sees upstream's releases. `CALANDRIA_UPDATE_FEED_URL` and `CALANDRIA_UPDATE_CHECK=off` are the two answers.
- **Desktop shell on an older server.** The page is served by the server, so an old server serves a page without the pill even inside a new shell. The tray menu still works there. Nothing to do.
- **`bundled` on a remote.** A remote server started from a desktop payload on another machine reports `bundled` with a browser shell. The popover then shows the release page link with no instructions, which is right: there is no supported way to run that server outside the app.
