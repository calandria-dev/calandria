---
title: "Automated testing for desktop builds (spike)"
---

# Automated testing for desktop builds (spike)

> **Status.** Researched 2026-08-25 (task `vbFrtiPclor_GKEWPFerK`), landed
> 2026-08-27. **Recommendation 1 is now done**: the proof-of-concept harness has
> been promoted into a real Playwright suite (`desktop/e2e/`, its own
> `playwright.desktop.config.ts`) and a `desktop` job runs it — plus the two
> supervisor scripts that ran nowhere — in `.github/workflows/test.yml`, on the
> same gate as `e2e`. Every §1 row below has since been re-measured, the last
> two by the tasks that reached them: the packaged-build row on 2026-08-27
> (there is an `electron-builder` config and a real artifact now) and the D-Bus
> notification row on 2026-08-28, against the real shell on the bench rather
> than a probe app. The
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
   `desktop/e2e/` (24 specs across eight files, nine of them platform-gated),
   plus the two supervisor scripts that already
   existed and ran nowhere (21 + 8 assertions). Zero infra, ~1.2 minutes of
   window suite on top of a build the lane needs anyway, and it covers the
   window lifecycle, the menu, single-instance, external links, the permission
   handler, the db-lock collision and quit-drains — the whole of §4's unverified
   list, for Linux.
2. ~~**One Proxmox VM: a Linux *desktop bench*.**~~ **Provisioned** 2026-08-25 —
   an Xfce session, VNC over an SSH tunnel, described in §5. Not yet registered
   as a **gated, ephemeral** GitHub Actions runner. It runs the native-integration
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
   repo) when packaging work starts. That lane has since landed — weekly rather
   than per-push, because free-to-us is not the same as cheap and a macOS runner
   bills at ten times a Linux one (§4).

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
| **A packaged build passes the same assertions** | `electron-builder --linux dir` → `CALANDRIA_TEST_BIN=…/calandria-desktop`: the harness takes the artifact or the dev shell through one switch. *(Re-verified 2026-08-27 on the bench VM, since the spike's numbers were never re-run: **15 passed, 2 skipped in 80 s**, the same figure for the relocated `--dir` output under Xvfb and for an installed `.deb` in the Xfce session. The artifact is much bigger than the spike's 282 MB — payload 1564 MB, `linux-unpacked` 2.1 GB, `.deb` 503 MB — which is the subject of its own task, "Trim the desktop payload's cross-libc duplicates".)* Two conditions make the run mean anything, both now enforced by `desktop/e2e/fixtures.ts`: **no `CALANDRIA_REPO_ROOT`** (the spike's packaged run was handed one, so it passed while still reading the repo — a real download would have died on the first boot) and the artifact **moved out of the checkout**, so nothing can resolve upward into a source tree that a user does not have. |
| **Electron's own `--headless` is not a substitute for Xvfb** | Same app without a display and `--headless`: the process dies with **SIGTRAP** before the CDP socket settles. Xvfb (or a real session) is mandatory, not a preference. |
| **Native notifications are assertable by machine** | `xvfb-run dbus-run-session -- (dunst &; dbus-monitor &; electron …)`: `Notification.isSupported() === true`, the `show` event fired, and `dbus-monitor` captured the real `org.freedesktop.Notifications.Notify` method call carrying the app name. This is the highest-value desktop-only feature and it does **not** need a human. *(Re-measured 2026-08-28 on the bench against the real shell. The technique holds, with one addition: capturing `type=method_return` alongside the call and correlating on the serial yields the notification id the DAEMON minted, which turns "the app called libnotify" into "a daemon accepted it" — `desktop/e2e/09-bench-notifications.spec.ts`. Deliberately not `dunstctl history`, which would make the assertion about dunst rather than about the session.)* |
| **Main-process reach is what a browser suite cannot do** | `app.evaluate()` read the application menu back as `["File","Edit","View","Window"]` (the roles macOS's Cmd+C/V depend on) and invoked `app.quit()`; the quit settled in **222 ms** *(170 ms on the 2026-08-27 re-run)* and `/api/version` stopped answering — i.e. `before-quit` → `supervisor.stop()` → drain → SIGTERM, asserted end to end. |
| **The single-instance lock is observable** | A second `electron.launch()` against the same app failed to launch in **64–73 ms** *(109 ms on the re-run)* rather than starting a second server — `requestSingleInstanceLock()` doing its job, visible to the harness as a rejected launch. |
| **The hermetic instance transfers unchanged** | `supervisor.js`'s `sidecarEnv()` forwards its own environment to both sidecars, so `e2e/env.ts`'s `SERVER_ENV` shape (temp `CALANDRIA_DB_DIR`/`CALANDRIA_WORKTREES_DIR`, pinned gitconfig, `CALANDRIA_E2E_MOCK_AGENT=1`) works as-is through `electron.launch({ env })`. No agent CLI, login or network is involved, exactly as in the browser suite. |
| **`chrome-sandbox` needs `--no-sandbox` from an unpacked dir** | As `DESKTOP_APP.md` §5 predicted, for the `--dir` output. The other half of that row was wrong and is corrected here: a packaged `.deb` does **not** install the SUID bit. electron-builder 26's `postinst` chmods the helper to **0755** wherever `unshare --user` works and ships `/etc/apparmor.d/calandria-desktop` instead, which is what keeps Chromium's namespace sandbox alive under Ubuntu 24.04's `kernel.apparmor_restrict_unprivileged_userns=1`. Measured on the bench with that sysctl at its stock `1`: the installed app's `--type=zygote` ran in `user:[4026532391]` against the main process's `user:[4026531837]`, renderers inheriting it; the same build under `--no-sandbox` had every process in the one namespace. So `06-packaged.spec.ts` asserts the **live** sandbox out of `/proc`, not a mode bit — a correctly installed app would fail the bit. |
| **Playwright disables the Electron sandbox for you** | Not in the spike, and it silently defeated the packaged-install lane: on Linux `_electron.launch()` *unshifts* `--no-sandbox` onto the argument list unless `chromiumSandbox: true` is passed (playwright-core 1.61.1, `Electron.launch`; documented as "Enable Chromium sandboxing. Defaults to `false`"). Omitting the flag is not enough — `app.commandLine.hasSwitch("no-sandbox")` read **true** against a launch that passed none. `fixtures.ts` now sets the argument and the option from the one `CALANDRIA_DESKTOP_SANDBOX` switch. |
| **Bug found by the harness: the shell ignores `PORT`/`PTY_PORT`** | `desktop/README.md` documents both. `main.js` constructed `new Supervisor({ repoRoot, resourcesPath, onLog, onExit })` and never passed `port`/`ptyPort`, so the class fell back to 3000/3001 and stepped from there: launching with `PORT=4830` bound **3002**. Documented behaviour that did not exist — found in the first hour of having a window test. **Fixed** (`preferredPorts()` in `supervisor.js`); the suite still reads the port back off the loaded window URL, because a busy preferred port is legitimately stepped past. |
| **Bug found by the suite: the boot screen had never shown a single line** | `loading.html`'s `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; …">` has no `script-src`, so its own inline `<script>` — the one defining `window.__log` — was blocked in every launch there has ever been. `main.js` pushed each sidecar line with ``executeJavaScript(`window.__log && window.__log(…)`)``, and the `&&` guard made the failure completely silent: a cold boot showed a spinner and an empty `<pre>`, which is exactly the "indistinguishable from a hang" the boot screen exists to prevent. **Fixed** by doing the DOM write from the main process (an evaluation is not subject to the page's CSP), so the strict policy stays and no script ships in that page at all. |
| **The app's own notifications freeze the main process on a headless box** | Electron's default permission CHECK grants notifications, so `Notification.permission` reads `granted` in the shell with nothing having asked, and `app/shell/useNotifications.ts` posts a real native one on every turn event. On Linux that is libnotify on the UI thread: with a session bus present but **no** daemon owning `org.freedesktop.Notifications` — every headless box, every GitHub runner — each call blocks the whole Electron main process for GDBus's 25 s timeout. Measured: the quit-drain spec's shutdown took **>90 s** (main process wedged, not even answering `app.evaluate`) and **0.2 s** with `DBUS_SESSION_BUS_ADDRESS` pointed at a socket that does not exist, so libnotify fails immediately. The suite sets that; the bench VM's notification specs must override it and run against a real daemon. **Half of this is now fixed at the source** (`DESKTOP_APP.md` §5.1): `main.js` sets a `setPermissionCheckHandler` that denies `notifications`, so the renderer's channel stands down and the page can no longer wedge anything. The hazard has not gone away, it has moved — the shell now raises notifications from the MAIN process, which is the same libnotify call on the same thread — so the dead-socket `DBUS_SESSION_BUS_ADDRESS` stays. What changed is who can trigger it: our own code, on a real notification, rather than the page on every turn event. |
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
| Permission handler: everything denied, notifications included — the main process owns that channel | `setPermissionRequestHandler` **and** `setPermissionCheckHandler`; the second is the one the app's own code reads |
| Closing the window hides it and leaves the server running; the quit that follows drains with the window back on screen | Tray residency and `before-quit` — a tab has neither |
| Native notification actually reaches the OS bus | D-Bus assertion above; the browser suite can only see the web-facing half |
| The db-lock collision reads as "another Calandria is running", not a crash | `onExit` + `dialog` path |
| One smoke path through the app inside the window (onboarding → project → turn) | Proves SSE/WebSocket/xterm survive Electron's renderer, once |
| The packaged artifact does all of the above, plus: it booted from `resources/app-payload` with no `CALANDRIA_REPO_ROOT`, spawned the Node it shipped, and (installed) is really sandboxed | It is what a user would download — and `desktop/e2e/06-packaged.spec.ts` is the only spec that cannot also run against the dev shell |

Not covered, deliberately: everything the browser suite already asserts, and
anything requiring a signed installer until installers exist.

## 4. Where it runs

| Lane | Runner | Scope | Trigger |
|-|-|-|-|
| **desktop-linux** (landed) | GitHub-hosted `ubuntu-24.04` + `xvfb-run` | `test-supervisor.js`, `test-real-boot.js`, the `_electron` suite; then `electron-builder --dir`, the artifact moved to `$RUNNER_TEMP`, and the window suite again against it with no `CALANDRIA_REPO_ROOT` | Same policy as the `e2e` job: main, dispatch, or the `e2e` label |
| **desktop-bench** (landed, runner not registered) | Proxmox VM, real session | The whole suite twice — dev shell, then an installed `.deb` at `/opt/Calandria` with the sandbox intact — plus three spec files gated on `CALANDRIA_DESKTOP_BENCH=1`: `09-bench-notifications`, `10-bench-tray`, `11-bench-window`. VNC for a human or an agent session to watch | `workflow_dispatch` + nightly, in its own workflow file (`.github/workflows/desktop-bench.yml`) with **no `pull_request` trigger at all** |
| **desktop-windows** (landed) | GitHub-hosted `windows-latest` | The shell's Windows half: `TerminateProcess` vs graceful drain, `taskkill` with and without `/T`, the `COMSPEC` pty shell, the bare-`node` spawn. Then, as on Ubuntu, `electron-builder --win dir`, the artifact moved to `$RUNNER_TEMP`, and the window suite again against it with no `CALANDRIA_REPO_ROOT` | Same expression as `desktop`/`e2e`: main, dispatch, or the `e2e` label |
| **desktop-macos** (landed) | GitHub-hosted `macos-latest` | The whole suite twice (dev shell, then a packaged `.app`), plus the three things only macOS has: the launchd PATH repair under a real `open` launch, the `hiddenInset` title bar, and the menu roles under a real menubar | **Weekly cron**, dispatch, or a PR carrying the `macos` label — not the shared `e2e` one |

Two facts that shape the later lanes. On Windows, `before-quit`/`will-quit` are
**not emitted at all** on system shutdown or logout — a `taskkill` on the app
does fire them (add `/T` or the node sidecars survive), so the Windows
drain test targets the app-quit and `taskkill` paths and must not claim to cover
the real OS-shutdown path. And GitHub-hosted minutes are free for a public repo
(2026 paid rates, for reference: Linux $0.006/min, Windows $0.010, macOS
$0.062 on a 3-vCPU M1) — so the argument for a self-hosted runner here is
capability and watchability, never cost.

**The lanes do not agree on how big the window is, and a product assertion can
turn on it.** The browser suite pins a viewport; this one cannot, because a real
OS window is half of what it exists to prove — so the renderer lays out at
whatever the runner's display allows. The hosted macOS and Windows runners have
a 1024x768 virtual display and clamp `main.js`'s requested 1440x900 down to fit
it; `xvfb-run`'s screen is larger and there is no window manager to clamp
anything, so the ubuntu lane really does get 1440x900. That gap cost a full
debugging round on PR #54, and three separate defects came out of it.

**The transcript at zero width.** At 1024 the app's three fixed columns
(236 + 352 + 430) left it ~4px, so 02-smoke's streamed message was present in
the DOM and in the accessibility snapshot, `hidden` to `toBeVisible`, and
identically red on both real-window-manager lanes. Two rules fix it and they
compose: a render-time floor under the transcript (`SESS_MAIN_MIN`) for a pane
too narrow for its tracks, and `AUTO_COLLAPSE_BELOW` (#66) shedding a side
column to a 30px spine so the pane does not get there. Both are pinned
Linux-side in `e2e/03-views.spec.ts`, so the desktop lane is no longer the only
thing standing between that layout rule and a release.

**A rail painting over the terminal drawer.** The 1024x768 window is short as
well as narrow, and the panes in `.session-body` are flex columns of
`flex:0 0 auto` chrome around one scroller — so a body shorter than its own
chrome overflows, and a plain overflowing block paints on top of the next thing
in the shell column. That is the drawer, and what it covers first is the
drawer's button bar. It surfaced as a 30s `locator.click` timeout on Hide with
`.tc-bar` named as the interceptor. `.tc-scroll`'s incompressible 40px
`padding-bottom` was the same bug one element lower; the general rule is that
`.session-body` clips and `.tc-bar` shrinks with its own scroll, so nothing is
lost that cannot be scrolled back to.

**A spec that assumed which columns were open.** Under `AUTO_COLLAPSE_BELOW` the
projects column is a 30px spine at 1024, so `getByText(PROJECT)` is not in the
document on the two clamped lanes and 02-smoke failed on its first assertion.
A suite with no viewport of its own must not navigate by clicking the sidebars:
it selects through the URL (`?project=&task=`) instead, and clicking through the
shell stays the browser suite's business at a viewport it pins.

Reproduce all three locally rather than by pushing: `xvfb-run -a -s "-screen 0
1024x768x24"` with `openbox` running inside it clamps the window to 1022x716
exactly as a hosted runner's WM does, and without a window manager Xvfb clamps
nothing, which is precisely why the ubuntu lane cannot see any of this. Note
that this file runs `serial`, so a red spec SKIPS the ones after it — the
drawer defect was hidden behind the transcript one for a full round. What
remains is a reading habit: a
desktop spec that fails on the windowed lanes and passes under Xvfb is a size
question until something rules it out, which is why `attachShellLog` now appends
the window's content bounds and the display's size to every failure it attaches.

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
`desktop/e2e/05-windows-quit.spec.ts` (win32-only) asserts what the two
`taskkill` spellings do. A plain one is a `WM_CLOSE`, and since close-to-tray
landed the shell answers it by **hiding**: the window goes, the process and both
sidecars stay, and no quit lifecycle runs — so the spec follows it with a real
`app.quit()` to show that *that* is what reaps them. `taskkill /F` without `/T`
is a `TerminateProcess` that orphans them, which is why the suite's own teardown
backstop uses `/T`. Both tests take the Electron pid from
`app.evaluate(() => process.pid)` rather than `app.process().pid`: on win32
Playwright launches Electron through a `cmd.exe` wrapper (`shell: true`), so the
pid it hands back is one generation above the process the sidecars hang off. `03-quit-drain.spec.ts`'s database assertion no longer
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

**Why the macOS lane is hosted, and why it is the one lane on a clock.** The
first half needed no deliberation: there is no Apple hardware in the homelab and
macOS has no legal path onto Proxmox/KVM, so unlike the Linux bench and the
Windows lane above there was no alternative to weigh. The second half is a cost
decision made in the open. A `macos-latest` runner is the priciest GitHub rents
— at 2026 rates $0.062/min on a 3-vCPU M1, roughly ten times Linux — and while a
public repo pays nothing for any of it, a lane that costs ten times its
neighbours is the wrong one to attach to every push. So `macos-desktop` is the
only job in `test.yml` with its own trigger: a Monday-morning cron, a manual
dispatch, or a PR that asks for it by name with the `macos` label. It
deliberately does **not** ride the `e2e` label the other three slow lanes share,
which would have made every PR wanting a browser run buy a Mac run with it. The
cron is also why the four always-on jobs now carry `github.event_name !=
'schedule'`: without that a weekly macOS run would drag a second full CI pass
along behind it.

What the lane pins beyond re-running the shared specs, both of them things
`docs/DESKTOP_APP.md` §5 had carried as assumptions since the spike.
`desktop/e2e/07-macos.spec.ts` asserts `titleBarStyle: "hiddenInset"` from the
outside: under `default` macOS draws a strip above the page and the window's
content box is shorter than its frame by exactly that, while under `hiddenInset`
the two rectangles are identical because the page now owns those rows. It also
goes a level deeper into the menubar than `01-shell.spec.ts` does — into the
submenus, where `undo`/`cut`/`copy`/`paste`/`selectAll` and the app menu's
`quit`/`hide` actually live, because on macOS those roles *are* Cmd+C/V/A rather
than a cosmetic duplicate of Chromium's own handling. And it attaches a
screenshot plus the element stack sitting under the traffic lights, uploaded on
a **green** run (`if: always()`, the only lane here that does), since "the
traffic lights overlap the app's own titlebar row — needs a look on a real
screen" is a question no assertion can answer.

`desktop/e2e/08-macos-launchd.spec.ts` is the one spec in this suite that does
not use `_electron`, and could not. Every other spec starts the binary as a
child of the test process, so the app inherits the runner's PATH — which is
precisely the environment in which the launchd repair is a no-op. This one
`open`s the packaged bundle through LaunchServices exactly as a double-click
does, captures its stdout with `open --stdout` (there is no CDP connection to
evaluate into), and reads back whether `supervisor.js` reported the stub PATH and
recovered a real one from the login shell. `launchctl setenv` is what keeps that
instance hermetic: the whole `instanceEnv()` shape goes into the user's launchd
domain and comes back out in `afterAll`.

**`open` forwards its caller's environment, and getting that wrong is what kept
this spec red for three runs.** The man page is explicit — "opened applications
inherit environment variables just as if you had launched the application
directly through its full path" — so the app's environment is the launchd domain
overlaid with `open`'s own, and the caller wins every key both hold. That is
exactly why the instance arrived and PATH did not: nothing in CI carries a
`CALANDRIA_DB_DIR`, so the domain's value was unopposed and the app really did
boot on the planted port against the planted database, while the planted stub
PATH was shadowed by `npm run test:desktop:window`'s. The fix is to withhold PATH
from `open` rather than plant it harder — with nothing to overlay, the domain is
the only source the app has for the one variable under test, and LaunchServices
stays in the launch, which is the whole reason the spec exists.

**PATH is planted in the domain too, and that is a deliberate retreat.** The
spec originally left PATH out so the run would measure launchd's stub rather
than assume it; run 33195354526 came back un-repaired and this document
concluded the runner image provisions a wider domain PATH. It does not follow:
that run read the caller's PATH through the shadowing above, so it was never
evidence about the image either way. `needsPathRepair()` was not at fault — it is
unchanged since the spike and unit-pinned on exactly that string. The plant
stays regardless, and is now load-bearing rather than redundant, because
asserting on whatever PATH the image happens to supply would make the lane's
colour a property of a runner nobody here controls. So the lane asserts the
repair (does a GUI-launched app reach the check with launchd's PATH, can a
login-shell probe answer from a process with no controlling terminal, does the
app then boot all the way with no `node` on PATH at all) and leaves the
inheritance premise to the
manual check in `docs/DESKTOP_APP.md` §5. The domain's pre-existing PATH is
attached on every run, read with `launchctl getenv` before the plant goes in —
an uncontaminated reading, unlike the draft's, since it comes from the domain
rather than from a launch. A run whose attachment reports no override is a run
on which the premise held. The spec also records how far beyond the stub the runner's own
login shell reaches — recorded, not asserted, since a bare image whose login
shell has nothing past `/etc/paths` makes the repair a correct no-op. The
packaged `.app` is ad-hoc signed (`codesign --sign -`) before either pass
launches it: arm64 macOS refuses to exec a Mach-O with no signature at all, and
electron-builder invalidates whatever Electron's prebuilt arrived with. That is
not Developer ID signing and it notarizes nothing — Gatekeeper and installers
remain `docs/DESKTOP_APP.md` §6's separate decision.

**The packaged-install run, concretely.** CI can package but cannot install, so
the un-flagged sandbox run is the bench's. Verified there on 2026-08-27
(Ubuntu 24.04, Xfce session on `:1`, Electron 44, Playwright 1.61.1):

```bash
cd desktop && npm run payload -- --no-build && npx electron-builder --linux dir deb
sudo dpkg -i dist/calandria-desktop_0.3.0_amd64.deb        # → /opt/Calandria
cd .. && DISPLAY=:1 CALANDRIA_TEST_BIN=/opt/Calandria/calandria-desktop \
  CALANDRIA_DESKTOP_SANDBOX=1 npm run test:desktop:window   # no xvfb-run, no --no-sandbox
```

15 passed, 2 skipped, 80 s. Note what is *not* in there: no `xvfb-run` (this is a
real session) and no `CALANDRIA_REPO_ROOT`. The bench's
`desktop_bench_allow_unprivileged_userns` knob should be left at stock (`1`) for
this run — the point is that the installed app sandboxes anyway.

**Self-hosted runners on a public repo are a security decision, not a
convenience.** A fork PR can execute arbitrary code on a self-hosted runner, and
this one would sit on VLAN 3 next to everything else. Non-negotiables for the
bench VM: never triggered by `pull_request` from a fork, registration as an
**ephemeral** runner (`--ephemeral`, one job per registration) backed by a
Proxmox snapshot rollback between jobs, its own credentials (no 1Password
service-account token, no cluster access), and exclusion from the nightly vzdump
job — it is rebuildable, not precious.

**The bench lane is its own workflow file, and that is the security control.**
`.github/workflows/test.yml` triggers on `pull_request`, so a job in it is one
careless `if:` edit away from letting a fork run code on a machine sitting on
VLAN 3. `.github/workflows/desktop-bench.yml` has two triggers —
`workflow_dispatch` and a nightly cron — and no `pull_request` among them, which
makes the property structural rather than conditional, and visible in two lines
rather than in a fifth gate expression that has to be kept in step with the
other four. A `github.repository ==` guard sits on top so a fork that leaves
scheduled workflows enabled queues nothing. Beyond the labels
(`self-hosted, linux, x64, desktop-bench`) the runner owes the lane two things:
the graphical session `desktop-bench-check` asserts, and passwordless
`sudo dpkg` for the install step.

**What the bench lane pins beyond re-running the shared specs.** Three files,
each reading the result from outside the app, because inside it every one of
these calls succeeds whether or not anything received it.
`09-bench-notifications.spec.ts` drives a mock turn onto a permission card and
captures the resulting `org.freedesktop.Notifications.Notify` on the session bus
**together with the daemon's reply** — two `dbus-monitor` match rules
correlated by serial, so the claim is "a daemon accepted this and minted id N"
rather than "we called libnotify". It asserts the server's own wording (title,
the `task · project` body, the failure's first line under it) precisely so that
a shell which ever starts composing its own text goes red.
`11-bench-window.spec.ts` pairs every window assertion with the WM's account of
it: `_NET_WM_STATE_HIDDEN` for a minimise (an atom the window manager sets and
the app cannot), the window leaving `_NET_CLIENT_LIST` for a close, and
`_NET_ACTIVE_WINDOW` naming the *same* window id after a second launch. Its
last test pins the tray-residency toast at once per launch rather than once per
close. `10-bench-tray.spec.ts` reads the tray from
`org.kde.StatusNotifierWatcher` — matched by the owner pid of the D-Bus
connection, since Electron's item is named `chrome_status_icon_N` and would not
be distinguishable from the session's other icons — and walks its menu over
`com.canonical.dbusmenu`, which is the only way to read a tray menu at all
(`Tray` is a setter with no getter) and also the only place the "N need you"
count is observable on a native surface.

**The tray file is red on the bench today, and not because of the shell.**
Measured 2026-08-28: xfce4-panel 4.18.4's built-in `systray` plugin crashes the
moment Electron 44 registers a status icon, taking the
`org.kde.StatusNotifierWatcher` name off the bus with it — sometimes logging
"Plugin systray-6 has been automatically restarted after crash", sometimes just
leaving the name unowned until the panel is restarted. Reproduced with both
committed tray assets (so it is not the 32×32 PNG) and with a nine-line Electron
app that does nothing but `new Tray(...)` (so it is not this shell), while
`nm_applet`'s icon on the same session is unaffected. The spec recognises the
unowned name and says all of that in its failure message rather than reading as
a missing tray. Two consequences, and they belong to different owners. The bench
needs a status-notifier host that survives a Chromium-shaped item before this
lane can be green — filed in the infra-claude project. **The product half is
fixed**: the shell's close-to-hide used to be gated on `new Tray()` not
THROWING, which stays true on a session where the icon never appears, so a close
hid the window into nowhere and the "open it again from the tray icon" toast
named an icon that did not exist. `desktop/tray-residency.js` now asks the
session the same two questions this spec asks it, on every close as well as at
boot, and an unconfirmed tray means the X button quits (with the drain) instead
of hiding — see `DESKTOP_APP.md` §5.1.

That changed what two spec files can assume, and both now **branch on the
session's answer rather than requiring one**. `11-bench-window.spec.ts` reads
the shell's verdict before it closes the window and asserts the matching
behaviour: a hide plus the residency toast where the icon is drawn, and a quit
plus *no* toast where it is not — the second being the assertion this bug most
needs, since that toast is the one message telling the user where the window
went. `03-quit-drain.spec.ts` does the same, which also gives the no-tray branch
its only coverage anywhere: the Linux CI lane runs under `xvfb` with no
status-notifier host, so it takes the quit branch while `windows-desktop` and
`macos-desktop` take the hide one, and the drain assertions after the branch are
identical either way. `10-bench-tray.spec.ts` keeps the one assertion only a
hosted session can make — that the shell's verdict agrees with the watcher's
own list.

## 5. The bench VM, concretely

Provisioned 2026-08-25 and live. This section describes what exists; the
plan it replaced said "put it on orion3", "labwc or GNOME" and left egress an
open question, and was wrong about all three.

| | |
|-|-|
| Host | `calandria-desktop-bench`, **192.168.3.70** (VLAN 3), VMID 3050 |
| Spec | Ubuntu 24.04, 4 vCPU / 8 GiB / 60 GiB on `ceph-ssd` |
| Placement | **HA-enabled with no placement rule — it floats across all four Orion nodes.** orion3 was only the clone target |
| Session | Xfce on `:1` — xfwm4, xfce4-panel with an explicit `systray` plugin (StatusNotifierItem host), dunst |
| Rendering | llvmpipe, `LIBGL_ALWAYS_SOFTWARE=1` (`llvmpipe (LLVM 20.1.2, 256 bits)`) |
| Installed | node v22.23.2, npm 10.9.8, gh 2.98.0, Docker 29.7.2, xvfb, the Chromium shared-library set |
| Rebuilt by | `roles/desktop_bench` + `desktop-bench.yml` in `ansible-orion` — idempotent, `ansible-lint` production profile. Fix drift by re-running the playbook, not by hand |
| Runner | Not registered yet. The ephemeral-runner rules in §4 still stand. The lane expects the labels `self-hosted, linux, x64, desktop-bench` and passwordless `sudo dpkg` (confirmed present on the VM 2026-08-28) |
| Backups | Excluded from the nightly vzdump job |

**Do not assume which node it is on.** PVE 9 replaced HA groups with
`/cluster/ha/rules`, and a resource with no rule attached is eligible
everywhere; ProxLB also live-migrates it on its own 12h cycle.

**Why Xfce**, which the plan did not consider: it is the mainstream target that
still fits 4 vCPU on llvmpipe, and GNOME 46 has no legacy tray at all — it would
have made tray testing *worse*, not more realistic. Xfwm4 reparents, which is
the class of behaviour Xvfb hides and the bench exists to catch.

### Access

VNC binds to **loopback only**, deliberately: reaching the session means SSH to
the box first, so the SSH key is the credential and there is no VNC password to
store anywhere.

```bash
ssh -L 5901:localhost:5901 penmoid@192.168.3.70
vncviewer localhost:5901
```

`desktop-bench-check` on the bench asserts the session is real rather than a
bare X server — it exits non-zero if any of the four things Xvfb cannot provide
is missing. It **is** the precondition in the native-integration specs —
`assertBenchSession()` in `desktop/e2e/bench.ts` runs it in every `beforeAll`,
and the lane runs it once more as its own step before `npm ci` so a broken
session fails in five seconds rather than after a build. Each spec file asks for
the checks it actually uses rather than for a green run overall, which matters
here specifically: the status area dies as soon as any spec launches the shell,
and an all-or-nothing precondition would take the notification and window files
down with the tray one over a daemon neither of them touches.

```
$ desktop-bench-check
display        :1
ok    X server reachable
ok    window manager running
ok    notification daemon
ok    status notifier host
window manager Xfwm4
gl renderer    llvmpipe (LLVM 20.1.2, 256 bits)
node           v22.23.2
```

### Four gotchas for the spec work

**The session bus is not the systemd user bus.** `dbus-run-session` mints its
own, and over SSH `pam_systemd` has *already* exported
`DBUS_SESSION_BUS_ADDRESS` pointing at `$XDG_RUNTIME_DIR/bus`. Anything talking
to the session's daemons from outside must read the address the session
publishes to `~/.vnc/session-bus` and **ignore the inherited value** — deferring
to it silently queries the wrong bus and reports healthy daemons as missing.

**Electron's namespace sandbox.** Ubuntu 24.04 ships
`kernel.apparmor_restrict_unprivileged_userns=1`, which denies it when the app
runs from a source checkout (`npx electron .`). The bench sets it to `0` so the
CI lane needs no `--no-sandbox`. A packaged `.deb` is unaffected either way,
because electron-builder's postinst makes `chrome-sandbox` SUID root — so a spec
asserting sandbox behaviour must be explicit about which of the two paths it
exercises. `desktop_bench_allow_unprivileged_userns` in the Ansible role flips
it back to stock 24.04.

**The panel's tray plugin does not survive Electron's status icon.** Measured
2026-08-28 and written up in §4: xfce4-panel 4.18.4's built-in `systray` plugin
crashes when Electron registers a `StatusNotifierItem`, and
`org.kde.StatusNotifierWatcher` goes with it — so `desktop-bench-check` starts
reporting `FAIL status notifier host` and the tray specs cannot find the icon.
Recovering the session by hand, until the role grows a host that survives it:

```bash
# NOT `pkill -f xfce4-panel` — the pattern matches the ssh command line running it
pkill -9 -x xfce4-panel; pkill -9 -x wrapper-2.0
sleep 2; (setsid nohup xfce4-panel >/dev/null 2>&1 &)
```

`Tray` construction still succeeds inside Electron, so the window, the badge and
the notifications are unaffected — but the shell now NOTICES the missing host
(`desktop/tray-residency.js`), so on a session in this state the X button quits
rather than hiding, which is what `11-bench-window.spec.ts` and
`03-quit-drain.spec.ts` branch on.

**`require` is not in scope inside `app.evaluate()`.** Playwright serialises the
callback and evaluates its body in the main process, where it gets no CommonJS
module wrapper — and `require` is a per-module parameter Node injects, not a
global, so it is simply undefined (measured). The main process entry IS
CommonJS, so reach its module's own require instead:

```js
const fs = process.mainModule.require("node:fs");
```

Verified populated under Electron 44, in both the dev shell and the packaged
app. The failure mode is what makes this worth writing down: Electron's async
stack stitching attributes the `ReferenceError: require is not defined` to
whatever main-process frame happened to be live, so the trace points at
unrelated application code (`rebuildTrayMenu`, in the case that found it) and
reads like a bug in `desktop/main.js`. It is always the spec.

### Egress — answered

**VLAN 3 egress to the public internet is open, subnet-wide**, checked against
the live ruleset rather than assumed: the UDM Pro's zone-based firewall sends
Internal→External through a catch-all ALLOW (the only blocks in that path are
scoped to one client MAC or to unrelated IPs), and the Proxmox firewall is
disabled at datacenter, node and VM level. Verified empirically — a real 200 on
an Electron CDN download from a VLAN 3 host, plus GitHub, npm, ghcr.io and
Docker Hub. One caveat before blaming your test: **IPS runs in active blocking
mode** on VLAN 3, not detect-only, so an intermittently dropped connection in a
CI job is worth checking against Suricata alerts before assuming a config
problem. Full write-up: `Infrastructure/Networking/VLAN Egress Policy.md` in the
Obsidian vault.

## 6. Cost

| Item | Cost |
|-|-|
| The `desktop-linux` CI lane | ~2–4 min for the dev-shell half, plus the packaged half: **25 s** to stage the payload and **20 s** for `electron-builder --dir` (bench, warm — a cold runner also pays a production-only `npm ci` and one ~30 MB Node download), then the window suite again at ~80 s. Free (public repo); the job's ceiling is 45 min |
| The `_electron` suite | Net-new test code; landed as `desktop/e2e/` (24 specs over eight files, nine of them Windows- or macOS-gated) with `desktop/test-window.js` retired into it |
| Bench VM | 4 vCPU / 8 GiB / 60 GiB, HA across the Orion nodes; one `ansible-orion` role + playbook; ongoing patching |
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
3. ~~Provision the bench VM~~ **Done** — `calandria-desktop-bench`, §5 for the
   access recipe and the three session gotchas. Still open: registering the
   gated ephemeral runner, the AWX job template for the playbook, and a
   status-notifier host that survives an Electron status icon (all tracked in
   infra-claude).
4. ~~Add `electron-builder` packaging, then point the same suite at the
   artifact.~~ **Done** — the `desktop` job packages, relocates and re-runs the
   window suite against the artifact, and `06-packaged.spec.ts` holds the
   payload/bundled-Node/sandbox assertions the dev shell cannot make. The
   `.deb`-install half was verified by hand on the bench (§4); it now has a lane
   of its own — item 7 below.
5. ~~Windows lane.~~ **Done** — the `windows-desktop` job, GitHub-hosted, with
   `05-windows-quit.spec.ts` for the `taskkill` paths. ~~The drain gap it pins is
   its own task ("Desktop shell: drain in-flight turns on quit under Windows").~~
   That task landed too: `supervisor.stop()` POSTs the drain over HTTP before it
   kills, so it no longer depends on a deliverable SIGTERM, and
   `03-quit-drain.spec.ts`'s `test.fail()` came off with it. What neither spec
   covers, and has no task yet, is the OS session-end path
   (`WM_QUERYENDSESSION`/`WM_ENDSESSION`), where Electron emits no quit event at
   all.
6. ~~macOS lane. Waits for packaging.~~ **Done** — the `macos-desktop` job,
   GitHub-hosted because there is no other option, and weekly rather than
   per-push because it is the one runner that costs ten times its neighbours
   (§4). `07-macos.spec.ts` settles the `hiddenInset` title bar and the menubar
   roles; `08-macos-launchd.spec.ts` settles the launchd PATH repair against a
   real `open` launch, which no `_electron` spec could ever observe. Both of
   those were open questions in `docs/DESKTOP_APP.md` §5. Signing, notarization
   and installers deliberately stay out: the lane ad-hoc signs only because
   arm64 will not exec an unsigned binary at all.
7. ~~Bench lane: the native-integration specs and the `.deb` install.~~
   **Landed** — `.github/workflows/desktop-bench.yml`, `workflow_dispatch` plus
   a nightly cron and no `pull_request` trigger at all (§4), running the whole
   suite against the dev shell and then against an installed `.deb`, with
   `09-bench-notifications`, `10-bench-tray` and `11-bench-window` on top.
   **Not yet executed by CI**: the ephemeral runner in item 3 does not exist, so
   the specs were run by hand on the bench instead. In a full-suite run there
   on 2026-08-28 (`DISPLAY=:1 CALANDRIA_DESKTOP_BENCH=1 npm run
   test:desktop:window`, 3.1 min) the notification and window-manager files pass
   and the tray file is red on the xfce4-panel bug §4 records — which is also
   what proved the per-capability precondition was worth having, since the tray
   crash happens on the FIRST shell launch of the run and an all-or-nothing
   check took the other two files down with it. The tray file's D-Bus reads were
   verified separately against a status-notifier item that IS registered
   (`nm_applet`'s). The packaged half was exercised too: `--linux dir deb`,
   `dpkg -i`, and the window suite against `/opt/Calandria` with
   `CALANDRIA_DESKTOP_SANDBOX=1`.
