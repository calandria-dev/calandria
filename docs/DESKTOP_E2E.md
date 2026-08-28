# Automated testing for desktop builds — spike

> **Status.** Researched 2026-08-25 (task `vbFrtiPclor_GKEWPFerK`), landed
> 2026-08-27. **Recommendation 1 is now done**: the proof-of-concept harness has
> been promoted into a real Playwright suite (`desktop/e2e/`, its own
> `playwright.desktop.config.ts`) and a `desktop` job runs it — plus the two
> supervisor scripts that ran nowhere — in `.github/workflows/test.yml`, on the
> same gate as `e2e`. Every §1 row below was re-measured on that landing except
> two, which should be re-measured by the task that reaches them: the
> packaged-build row (`desktop/package.json` still has no `electron-builder`, so
> there is no artifact to point at) and the D-Bus notification row. The
> `PORT`/`PTY_PORT` bug §1 records has since been fixed; two NEW bugs the suite
> found on its first green run are recorded in its place. Recommendation 3 has
> been rewritten since: Windows is no longer blocked.

**Question:** the Electron shell in [`desktop/`](../desktop) has an entirely
unverified window layer ([`DESKTOP_APP.md`](DESKTOP_APP.md) §4: "everything that
needs a display"). How do we test it — and eventually a packaged build —
automatically, given the homelab can run VMs on Proxmox?

**Answer:** Playwright's Electron driver under Xvfb, in the repo's existing CI.
It was measured working on this headless box today, against both `electron .`
and an `electron-builder` package: real window, real sidecars, real app, real
screenshots, native notifications assertable over D-Bus, `app.quit()` draining
the server. Nothing about it needs a VM. The Proxmox capacity buys the *second*
tier — a real desktop session and per-OS coverage — and is worth exactly one VM
today.

**Recommendation, in order:**

1. ~~**A `desktop` lane in `.github/workflows/test.yml`, on the ubuntu runner we
   already use.**~~ **Landed.** `xvfb-run` + the Playwright `_electron` suite in
   `desktop/e2e/` (11 specs), plus the two supervisor scripts that already
   existed and ran nowhere (21 + 8 assertions). Zero infra, ~1.2 minutes of
   window suite on top of a build the lane needs anyway, and it covers the
   window lifecycle, the menu, single-instance, external links, the permission
   handler, the db-lock collision and quit-drains — the whole of §4's unverified
   list, for Linux.
2. **One Proxmox VM: a Linux *desktop bench*.** A real session (labwc or GNOME +
   D-Bus + a notification daemon), VNC/RDP for a human, registered as a
   **gated, ephemeral** GitHub Actions runner. It runs the native-integration
   half — notifications, tray, window manager behaviour, packaged `.deb`/
   AppImage install — and doubles as the machine where "first run on a machine
   with a display" actually happens.
3. **Windows landed on the hosted runner** (revised twice — it said "defer"
   when this was written, then "unblocked"). The server's Windows blockers were
   open then; they have since landed, and `.github/workflows/test.yml` now
   carries a `windows-desktop` job alongside `windows` and `windows-e2e`, whose
   runner setup it copies. The Proxmox template (`windows-11-template`, VMID
   9911) was not needed and is not used: §4 has the reasoning, but the short
   version is that a hosted Windows runner already has a real window station,
   so the display argument that justifies the Linux bench has no counterpart
   here.
4. **macOS is not a homelab problem.** No Apple hardware, and Proxmox cannot
   legally run macOS. Use GitHub-hosted `macos-latest` (free for this public
   repo) when packaging work starts, and accept that until then macOS is
   covered by a human running the shell once.

---

## 1. Measured findings

Every row was run on this machine (headless Linux x64, Node 22.18.0,
Electron 44.0.0, Playwright 1.61.1, `xvfb-run` with `-screen 0 1440x900x24`).
The harness was `desktop/test-window.js`; it is now the suite in
[`desktop/e2e/`](../desktop/e2e), run by `npm run test:desktop`.

| Finding | Measurement |
|-|-|
| **Playwright drives Electron 44 headlessly** | `_electron.launch()` against a minimal app: first window in **435 ms**, `evaluate()` in the main process returned Electron 44.0.0 / Chrome 152.0.7977.54 / Node 24.18.1, screenshot written. |
| **The real shell boots the real app under Xvfb** | `xvfb-run node desktop/test-window.js`: first window **272 ms**, app URL loaded at **2316 ms**, the onboarding wizard rendered at 1440×900, 157 KB PNG. The window layer that had never rendered now renders in CI-shaped conditions. *(Re-run 2026-08-27 against the current tree: 531 ms / 1873 ms, 143 KB PNG, all seven assertions green. As the promoted suite: 356 ms first window, ~2.0 s to the app URL, 11 specs green in 1.2 min including three full boots.)* |
| **A packaged build passes the same assertions** (not re-run on landing) | `electron-builder --linux dir` (282 MB out) → `CALANDRIA_TEST_BIN=…/calandria-desktop`: identical run, app URL at **1353 ms**. The harness takes the artifact or the dev shell through one switch. |
| **Electron's own `--headless` is not a substitute for Xvfb** | Same app without a display and `--headless`: the process dies with **SIGTRAP** before the CDP socket settles. Xvfb (or a real session) is mandatory, not a preference. |
| **Native notifications are assertable headlessly** (not re-run on landing) | `xvfb-run dbus-run-session -- (dunst &; dbus-monitor &; electron …)`: `Notification.isSupported() === true`, the `show` event fired, and `dbus-monitor` captured the real `org.freedesktop.Notifications.Notify` method call carrying the app name. This is the highest-value desktop-only feature and it does **not** need a human. |
| **Main-process reach is what a browser suite cannot do** | `app.evaluate()` read the application menu back as `["File","Edit","View","Window"]` (the roles macOS's Cmd+C/V depend on) and invoked `app.quit()`; the quit settled in **222 ms** *(170 ms on the 2026-08-27 re-run)* and `/api/version` stopped answering — i.e. `before-quit` → `supervisor.stop()` → drain → SIGTERM, asserted end to end. |
| **The single-instance lock is observable** | A second `electron.launch()` against the same app failed to launch in **64–73 ms** *(109 ms on the re-run)* rather than starting a second server — `requestSingleInstanceLock()` doing its job, visible to the harness as a rejected launch. |
| **The hermetic instance transfers unchanged** | `supervisor.js`'s `sidecarEnv()` forwards its own environment to both sidecars, so `e2e/env.ts`'s `SERVER_ENV` shape (temp `CALANDRIA_DB_DIR`/`CALANDRIA_WORKTREES_DIR`, pinned gitconfig, `CALANDRIA_E2E_MOCK_AGENT=1`) works as-is through `electron.launch({ env })`. No agent CLI, login or network is involved, exactly as in the browser suite. |
| **`chrome-sandbox` needs `--no-sandbox` from an unpacked dir** | As `DESKTOP_APP.md` §5 predicted. A packaged `.deb`/AppImage installs the SUID bit; the `--dir` output does not, so the harness passes `--no-sandbox` and a **packaged-install** test must not. |
| **Bug found by the harness: the shell ignores `PORT`/`PTY_PORT`** | `desktop/README.md` documents both. `main.js` constructed `new Supervisor({ repoRoot, resourcesPath, onLog, onExit })` and never passed `port`/`ptyPort`, so the class fell back to 3000/3001 and stepped from there: launching with `PORT=4830` bound **3002**. Documented behaviour that did not exist — found in the first hour of having a window test. **Fixed** (`preferredPorts()` in `supervisor.js`); the suite still reads the port back off the loaded window URL, because a busy preferred port is legitimately stepped past. |
| **Bug found by the suite: the boot screen had never shown a single line** | `loading.html`'s `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; …">` has no `script-src`, so its own inline `<script>` — the one defining `window.__log` — was blocked in every launch there has ever been. `main.js` pushed each sidecar line with ``executeJavaScript(`window.__log && window.__log(…)`)``, and the `&&` guard made the failure completely silent: a cold boot showed a spinner and an empty `<pre>`, which is exactly the "indistinguishable from a hang" the boot screen exists to prevent. **Fixed** by doing the DOM write from the main process (an evaluation is not subject to the page's CSP), so the strict policy stays and no script ships in that page at all. |
| **The app's own notifications freeze the main process on a headless box** | Electron's default permission CHECK grants notifications, so `Notification.permission` reads `granted` in the shell with nothing having asked, and `app/shell/useNotifications.ts` posts a real native one on every turn event. On Linux that is libnotify on the UI thread: with a session bus present but **no** daemon owning `org.freedesktop.Notifications` — every headless box, every GitHub runner — each call blocks the whole Electron main process for GDBus's 25 s timeout. Measured: the quit-drain spec's shutdown took **>90 s** (main process wedged, not even answering `app.evaluate`) and **0.2 s** with `DBUS_SESSION_BUS_ADDRESS` pointed at a socket that does not exist, so libnotify fails immediately. The suite sets that; the bench VM's notification specs must override it and run against a real daemon. |
| **No GPU exists anywhere on the Proxmox fleet** | orion1–4 expose only ASPEED BMC video; carina1–3 only Intel Iris Xe. No passthrough is configured. SwiftShader/llvmpipe is therefore the only rendering path — which the measurements above already use, so this costs nothing. |

Setup cost of all of the above on a bare headless box: `apt install xvfb
x11-utils xauth dbus-x11` + Chromium's usual library set, `npm install` in
`desktop/` (Electron's 227 MB binary needs `node node_modules/electron/install.js`
if the postinstall did not run), and `npm run build` in the repo root.

## 2. Tooling: why Playwright and not something else

| Tool | Verdict |
|-|-|
| **Playwright `_electron`** (recommended) | The suite, the assertions, the fixtures and the CI habits already exist in this repo — `_electron.launch()` reuses all of them and adds `evaluate()` into the **main process**, which is where every shell-only fact lives. Still labelled experimental in Playwright's docs; it has been stable in practice for years, and the measurements above are on 1.61.1 + Electron 44. One documented caveat that matters for the packaged lane: **trace/video capture against a packaged app is unreliable** ([microsoft/playwright#13180](https://github.com/microsoft/playwright/issues/13180)) — so the packaged run keeps screenshots-on-failure and log capture, not traces. |
| **`@wdio/electron-service`** | The real alternative — now maintained in the WebdriverIO org, auto-matches Chromedriver to the app's Electron version, autodetects electron-builder/Forge output, and can **mock Electron API classes** (`browser.electron.mock('Tray')`). Worth revisiting only if we start needing to fake native surfaces rather than exercise them; adopting a second browser-automation stack to get that is not worth it today. |
| **Spectron** | Dead. Deprecated 2022-02-01 and archived; Electron's own docs point at Playwright/WebdriverIO. Named here so nobody re-proposes it. |
| **nut.js** (or robotjs, AutoHotkey, xdotool) | Real OS-level input and pixel reads. Justified only for something neither CDP nor the Electron API can observe — clicking a tray icon's real menu, say. Everything on our list (menu roles, single-instance, quit-drain, permissions, external links, notifications) is reachable through `app.evaluate()` or the D-Bus assertion above, which is far less flaky. Keep it in reserve. |
| **Cypress** | Renderer-only, no main process, and its external-Electron plugin is alpha. Wrong tool. |

Display backend: `xvfb-run` is still the documented path and is what was measured
here. Electron's own CI has since added a **Weston-based headless Wayland job**
([electron/electron#49908](https://github.com/electron/electron/pull/49908)) —
relevant to the bench VM below if we want to test under a compositor rather than
a bare X server, but not a reason to move the CI lane off Xvfb.

## 3. What a desktop suite should and should not cover

The browser suite (`e2e/`, 23 specs) already drives the product through
Chromium. Re-running it inside Electron would double the wall clock to re-prove
the same things — same Chromium, same server, same DOM. The desktop lane exists
for what only the shell can break:

| Covered by the desktop lane | Why it is shell-only |
|-|-|
| Boot: window appears, boot screen streams logs, swaps to the app | The supervisor→window handoff has no browser equivalent |
| Application menu content and roles | Native menu; `Menu.getApplicationMenu()` via the main process |
| Quit drains in-flight turns (start a mock turn with `e2e:sleep=…`, quit, assert the turn settled and the server exited) | The whole point of `before-quit`; a browser tab cannot stop a server |
| Second launch focuses instead of starting a second server | `requestSingleInstanceLock` + the DB lock, together |
| External links leave for the real browser (`setWindowOpenHandler` / `will-navigate`) | Renderer navigation policy |
| Permission handler: notifications granted, camera/mic denied | `session.setPermissionRequestHandler` |
| Native notification actually reaches the OS bus | D-Bus assertion above; the browser suite can only see the web-facing half |
| The db-lock collision reads as "another Calandria is running", not a crash | `onExit` + `dialog` path |
| One smoke path through the app inside the window (onboarding → project → turn) | Proves SSE/WebSocket/xterm survive Electron's renderer, once |
| The packaged artifact does all of the above | It is what a user would download |

Not covered, deliberately: everything the browser suite already asserts, and
anything requiring a signed installer until installers exist.

## 4. Where it runs

| Lane | Runner | Scope | Trigger |
|-|-|-|-|
| **desktop-linux** (landed) | GitHub-hosted `ubuntu-24.04` + `xvfb-run` | `test-supervisor.js`, `test-real-boot.js`, the `_electron` suite; `electron-builder --dir` + the same suite against the artifact once packaging exists | Same policy as the `e2e` job: main, dispatch, or the `e2e` label |
| **desktop-bench** | Proxmox VM, real session | Native-integration extras: notification daemon, tray, WM behaviour, `.deb`/AppImage install-and-run with the SUID sandbox intact, VNC for a human or an agent session to watch | `workflow_dispatch` + nightly; never on fork PRs |
| **desktop-windows** (landed) | GitHub-hosted `windows-latest` | The shell's Windows half: `TerminateProcess` vs graceful drain, `taskkill` with and without `/T`, the `COMSPEC` pty shell, the bare-`node` spawn. Packaged NSIS run when packaging reaches Windows | Same expression as `desktop`/`e2e`: main, dispatch, or the `e2e` label |
| **desktop-macos** | GitHub-hosted `macos-latest` | launchd PATH repair against a real GUI PATH, `hiddenInset` title bar, notarization smoke | When packaging starts |

Two facts that shape the later lanes. On Windows, `before-quit`/`will-quit` are
**not emitted at all** on system shutdown or logout — a `taskkill` on the app
does fire them (add `/T` or the node sidecars survive), so the Windows
drain test targets the app-quit and `taskkill` paths and must not claim to cover
the real OS-shutdown path. And GitHub-hosted minutes are free for a public repo
(2026 paid rates, for reference: Linux $0.006/min, Windows $0.010, macOS
$0.062 on a 3-vCPU M1) — so the argument for a self-hosted runner here is
capability and watchability, never cost.

**Why the Windows lane is hosted rather than the homelab's VM 9911.** The
deciding question is what a real logged-in session buys, and on Windows the
answer is nothing this suite asserts. A hosted `windows-latest` runner has a
real window station and desktop: Electron opens a genuine window on it and
`01-shell.spec.ts` screenshots it, with no display server to install — the
`windows-desktop` job has no display step at all, which is exactly the
difference from the Ubuntu one. The base was already proven twice over in this
repo's own CI before the lane existed (`windows` runs the unit suite; `windows-e2e`
boots `server.js` + the pty sidecar through `scripts/start.mjs` and drives
Chromium against them), so all the desktop lane adds is Electron. Against that,
a self-hosted Windows runner costs a licence and an activation story, its own
fork-PR gating, ephemeral registration with snapshot rollback, and patching. The
Linux bench VM exists because a Linux runner has **no** display and `xvfb` hides
a class of window-manager and compositor behaviour; that argument has no Windows
counterpart, and the native-integration specs that genuinely need a live session
stay on the bench where they belong.

What the landed lane pins, beyond re-running the shared specs:
`desktop/e2e/05-windows-quit.spec.ts` (win32-only) asserts that a plain
`taskkill` runs `before-quit` and takes the sidecars with it, and that
`taskkill /F` without `/T` orphans them — which is why the suite's own teardown
backstop uses `/T`. `03-quit-drain.spec.ts`'s database assertion no longer
carries the `test.fail()` annotation it used to on Windows: the supervisor now
POSTs `/api/instance/drain` and waits for it before it ever sends the kill, so
the drain happens whether or not the platform can deliver a signal, and the
assertion holds on every runner in the matrix. `desktop/test-supervisor.js`
branches rather than skips on the same three POSIX-semantics cases (`stop()`'s
drain, the SIGKILL escalation, `needsPathRepair`), and adds the two Windows
behaviours worth naming: `sidecarEnv()` filling in a `SHELL` from `COMSPEC`
(falling back to `powershell.exe`, never overwriting an inherited one), and the
sidecars being a bare `node <script>` spawn carrying `NODE_ENV` in the env
object — no `NODE_ENV=x` prefix for `cmd.exe` to read as a program name, no
shell in between. Neither spec can cover the one case that matters most on
Windows: a real shutdown or logout emits neither `before-quit` nor `will-quit`
at all, so nothing drains, and no `session-end` listener exists yet to catch it.

**Self-hosted runners on a public repo are a security decision, not a
convenience.** A fork PR can execute arbitrary code on a self-hosted runner, and
this one would sit on VLAN 3 next to everything else. Non-negotiables for the
bench VM: never triggered by `pull_request` from a fork, registration as an
**ephemeral** runner (`--ephemeral`, one job per registration) backed by a
Proxmox snapshot rollback between jobs, its own credentials (no 1Password
service-account token, no cluster access), and exclusion from the nightly vzdump
job — it is rebuildable, not precious.

## 5. The bench VM, concretely

Sized from the live inventory: Orion has 51–99 GiB free per node and 29 TiB of
Ceph headroom; Carina does not (carina1 has 6 GiB free). Put it on **orion3**,
the lightest-loaded node.

| | |
|-|-|
| Base | Ubuntu 24.04 template (VMID 9901), 4 vCPU / 8 GiB / 60 GiB |
| Provisioned by | `ansible-orion`'s `roles/proxmox_vm` + an entry in `vars/vms_orion.yml`, run through `provision-vms.yaml` (no AWX job template exists for it yet — that is a prerequisite step, not a blocker) |
| Software | Node 22 (`.nvmrc`), git, `gh`, Xvfb + the Chromium library set, a real session (labwc or GNOME), `dbus-x11`, `dunst`, a VNC/RDP server, Docker (so the existing `*:docker` lanes work there too) |
| Rendering | SwiftShader/llvmpipe. No GPU exists on the fleet and none is needed — every measurement above was software-rendered |
| Runner | GitHub Actions self-hosted, ephemeral, labels `self-hosted,linux,x64,desktop` |
| Backups | Excluded from the nightly vzdump job |

Why a VM at all, when the ubuntu runner already does most of it: a real session
is what surfaces the class of bug Xvfb hides — a window manager that reparents,
a compositor that ignores `titleBarStyle`, a tray icon with no AppIndicator host,
a notification daemon with its own idea of urgency — and it is the only place
where a human (or a Calandria agent session with VNC) can *watch* the app run
and take over. It is also where the packaged `.deb` can be installed as a user
would install it, SUID sandbox and all.

## 6. Cost

| Item | Cost |
|-|-|
| The `desktop-linux` CI lane | ~2–4 min per run on top of an existing job matrix; free (public repo) |
| The `_electron` suite | Net-new test code; landed as `desktop/e2e/` (11 specs over four files) with `desktop/test-window.js` retired into it |
| Bench VM | 4 vCPU / 8 GiB / 60 GiB on orion3 + one Ansible inventory entry; ongoing patching |
| Ephemeral-runner plumbing | Snapshot rollback + registration token handling; the homelab has **no** self-hosted runner infrastructure today, so this is net-new |
| Windows lane | Landed: free minutes on GitHub-hosted `windows-latest`, ~2x the Ubuntu lane's wall clock. Deliberately not the Proxmox template — see §4 |
| macOS lane | Free minutes; the real cost is signing/notarization, already priced in `DESKTOP_APP.md` §6 |

## 7. Next steps

1. ~~Land the `_electron` suite and the `desktop-linux` CI lane (the two existing
   supervisor scripts go with it — they run nowhere today).~~ **Done** — the
   `desktop` job in `.github/workflows/test.yml`.
2. ~~Fix the `PORT`/`PTY_PORT` bug the harness found, and give the suite a
   deterministic port so it cannot collide with a live instance.~~ **Done** —
   `preferredPorts()`, and the suite's own `CALANDRIA_DESKTOP_E2E_PORT` base
   (4741, clear of the browser suite's 4711).
3. Provision the bench VM and register the gated ephemeral runner.
4. Add `electron-builder` packaging, then point the same suite at the artifact.
5. ~~Windows lane.~~ **Done** — the `windows-desktop` job, GitHub-hosted, with
   `05-windows-quit.spec.ts` for the `taskkill` paths. ~~The drain gap it pins is
   its own task ("Desktop shell: drain in-flight turns on quit under Windows").~~
   That task landed too: `supervisor.stop()` POSTs the drain over HTTP before it
   kills, so it no longer depends on a deliverable SIGTERM, and
   `03-quit-drain.spec.ts`'s `test.fail()` came off with it. What neither spec
   covers, and has no task yet, is the OS session-end path
   (`WM_QUERYENDSESSION`/`WM_ENDSESSION`), where Electron emits no quit event at
   all.
6. macOS lane. Waits for packaging.
