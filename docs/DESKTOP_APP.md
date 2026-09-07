---
title: "Desktop app"
---

# Desktop app

Calandria's desktop app is a thin Electron shell around the same server you run with
`npm start` or self-host elsewhere. It starts the server, waits for it to come up, and shows
it in a window; when you quit, it waits for any running turns to finish before the server
stops. Using it instead of a browser tab adds four things: native OS notifications when a
task needs you, a dock or taskbar badge with a running count, a tray icon that keeps the
server alive after you close the window, and automatic updates. The window can also switch
between several Calandria servers, so one app reaches your own machine, a remote server over
HTTPS, and a server behind SSH, without separate browser tabs or bookmarks for each.

## Installing

Get a build from the project's Releases page, or build one yourself. See
`../desktop/README.md` for how release builds are produced and signed. macOS ships as a
`.dmg` you drag into Applications, or a `.zip` if you'd rather not mount a disk image.
Windows ships as an NSIS installer (`Calandria Setup <version>.exe`) or a `.zip` for anyone
who'd rather not run an installer. Linux ships as a `.deb` or an `.AppImage`. Every build
bundles its own Node runtime and server payload, so it doesn't depend on anything already
installed on your machine.

### macOS

Official release builds are signed with a Developer ID certificate and notarized, so
Gatekeeper opens them without complaint.

If you build your own copy locally (`npm run dist:mac`), the result carries an ad-hoc
signature only. macOS refuses to run an ad-hoc-signed app that arrived from another machine,
usually with a dialog reading "Calandria is damaged and can't be opened. You should move it
to the Trash." The app is not corrupt; it just carries no identity Gatekeeper recognizes.
Clear the quarantine flag macOS attached to it:

```bash
xattr -dr com.apple.quarantine /Applications/Calandria.app
```

or right-click the app, choose Open, and confirm the dialog. Either way, this is a per-install
step, not a one-time fix: do it again on any other machine that didn't build the copy itself.

### Windows

Windows builds are not code-signed yet. The first time you run a downloaded installer or the
zipped executable, Windows Defender SmartScreen shows a full-screen "Windows protected your
PC" warning whose only obvious button is Don't run. Click **More info**, then **Run anyway**.
The zip target does not avoid this: Windows tags anything extracted from a browser download
the same way it tags the installer.

### Linux

Running the app from an unpacked directory, including a plain `npm start` checkout, needs
`chrome-sandbox` owned by root with mode 4755, or Electron refuses to start with a sandbox
error. Installing the `.deb` handles this automatically: its post-install step lays down an
AppArmor profile instead, which lets the sandbox work under Ubuntu's stricter user-namespace
defaults. For an AppImage or an unpacked build run directly, either fix the sandbox helper's
ownership yourself or pass `--no-sandbox` when launching.

## First launch

The app opens on a boot screen with a spinner while the server starts. A cold first launch
can take a little while, so after about 12 seconds a line appears confirming it's still
working, not stuck. The server's own log lines stream into this screen as it starts,
which is useful if something goes wrong.

If another copy of Calandria is already running against the same database, the app tells you
so directly, as "another Calandria is already running," instead of failing silently or
looking like a crash.

## Setting environment variables

A Finder, Dock, or Start Menu launch hands the app a minimal environment with nothing sourced
and nothing exported, so a PATH addition, an `ANTHROPIC_API_KEY`, or anything else your shell
profile normally sets is invisible to it. To pass variables in anyway, write `KEY=VALUE` lines,
one per variable, to `~/.config/calandria/env` (`$XDG_CONFIG_HOME/calandria/env` if that's
set); `CALANDRIA_ENV_FILE` points at a different file instead. The app reads it before starting
its server, layering it over what it inherited. The format supports comments (`#`) and quoted
values but does no shell-style expansion: `$VAR` references and command substitution are taken
literally, not evaluated. A missing file is not an error; the app just starts without it.

## Instances

The desktop app is not tied to one server. It keeps a small list of instances and points its
one window at whichever is active. The list lives at `~/.config/calandria/instances.json`;
override the path with `CALANDRIA_INSTANCES_FILE`. A `local` instance, the server the app
starts on this machine, is always first in the list. Alongside it you can add any number of
`url` instances, a Calandria reachable at an HTTPS origin, and `ssh` instances, a Calandria
reachable by forwarding a port over SSH. Add an instance for anything beyond the server you
run on this machine: a team's Calandria reached over a Cloudflare Tunnel, a workstation you
SSH into, or a self-hosted instance running on a home server. Each instance keeps its own
login, its own tasks, and its own badge count. A malformed or hand-edited entry in the file
is dropped or repaired automatically; it does not break the app.

Adding an instance asks for a name and an address:

- A bare host or URL is read as an HTTPS origin: a Cloudflare Tunnel hostname or a LAN box
  behind TLS both work this way. Only the origin is kept; any path is dropped.
- An address starting with `ssh://` adds an SSH instance instead: `ssh://build`,
  `ssh://me@build`, or `ssh://build:3000` if the remote Calandria isn't on the default port.
  That port belongs to the remote server, not to `sshd`; how to reach the host itself is
  whatever your `~/.ssh/config` says, including any `Host` alias. An `ssh` entry can also pin
  the local end of the forward to a fixed port instead of letting the app pick a free one,
  useful if something else expects the forward at a constant address.

Attaching works differently per kind:

- **local** starts the server on this machine if it isn't already running, then loads it.
- **url** checks the server's version over HTTPS, then loads the page.
- **ssh** opens an SSH port forward first, waits for the local end to come up, then behaves
  exactly like a `url` instance from there on.

A server running a much older version than the app expects still loads, with a dismissible
banner naming both versions. The app does not refuse to open a Calandria that still works. A version
the app can't parse at all, such as a dev build, is not treated as out of date. If a remote
instance sits behind a login, whether Cloudflare Access or an ordinary redirect-based login
page, the app shows you that page in the window; this is a browser, and signing in happens
the same way it would in one. If an instance doesn't answer at all, the boot screen shows the
error with **Retry** and **Switch instance** buttons.

Every instance except `local` gets its own separate cookie storage. Signing in on one remote
instance never signs you into another, even behind the same login provider, and there is no
separate sign-out button to remember: removing an instance clears its stored cookies with it.

The SSH connection uses your ordinary `ssh` binary, run roughly as:

```bash
ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes \
    -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort> <host>
```

It runs non-interactively, so it can't prompt you for a password or a 2FA code. Set up
key-based authentication first (`ssh-copy-id <host>`), or keep an existing connection open
with `ssh -fN <host>` before attaching. If the tunnel drops after connecting successfully,
the app shows ssh's own error and retries on its own with backoff, reconnecting to the same
local port so your session and selection aren't disturbed.

Switching instances uses an **Instance** submenu in both the tray menu and the application
menu: a list of your saved instances, plus **Add instance…** and **Manage instances…**.
Switching away from an instance doesn't stop anything running on it: the `local` server keeps
running in the background, and an SSH tunnel you're not currently viewing stays open. The
window title always shows which instance you're on, as "*&lt;instance name&gt;* · Calandria".

The notification badge, dock or taskbar, is a sum across every reachable instance, not just
the one on screen. A `url` instance counts toward it whether or not it's active, and so does
`local` whenever its server is running. An `ssh` instance is only watched while you're
attached to it, so a background badge does not reflect an `ssh` instance you've switched away
from. Clicking a notification that came from a background instance switches the window to
that instance and opens the task it's about.

What instances don't do: an unattached `ssh` instance doesn't contribute to the badge, since
nothing is watching it while you're elsewhere. The app can't install or launch a Calandria
server on a remote machine for you; that's a self-hosting task, covered in `SELF_HOSTING.md`.
There is nothing cross-instance on the server side either, no shared task list or inbox
spanning servers. One more limitation is specific to SSH: a managed service exposed on its
own hostname (`<slug>--<appHost>`) does not route through an SSH forward, because the forward
only carries a loopback port, not a hostname. To reach an exposed service on a server you've
attached over SSH, forward that service's own port too (`ssh -L 8080:127.0.0.1:8080 <host>`,
then open `127.0.0.1:8080`), open the server's public service hostname directly in an
ordinary browser, or add that server as a `url` instance instead.

## Signing in to an instance

A `url` or `ssh` instance behind a login normally shows that login inside the window, the
same way a browser tab would, and that works fine for a password or an emailed code. It
doesn't work for a passkey, a security key, or a login that hands off to a QR code or a TOTP
app: Electron has no WebAuthn implementation, and completing that step needs your system's
real browser and its own cookie jar, not the window's separate one. If an instance needs one
of these and can't finish it in-window, a dismissible banner points you at Settings to
configure browser-based sign-in for that instance instead.

From Manage instances → an instance's sign-in settings, you can configure one of two kinds:

- **Browser sign-in.** Runs the whole OAuth login in your system browser through a one-shot
  local receiver, then hands control back to the app. Needs an OpenID Connect provider
  registered as a public client; there's no client secret to enter or store.
- **Header credential.** Sends one or more request headers you already hold, such as an
  authentik app password, Cloudflare Access's two service-token headers, or a personal access
  token. Use this when whatever sits in front of the server doesn't speak OIDC. It's the
  weaker of the two to revoke, since taking it away means rotating the credential at its
  source.

Either kind works the same way once configured: the app attaches the credential as request
headers on everything that instance's window sends, including the live transcript stream and
the terminal's connection. An instance with no sign-in configured keeps working exactly as
before, including the in-window login path (a Cloudflare Access PIN, a password form, an
OTP); configuring browser-based sign-in is optional and doesn't take those away.

A credential nearing expiry renews itself in the background. Saved credentials live in
`~/.config/calandria/credentials.json` next to the instance list, never inside
`instances.json` itself, since that file is meant to be hand-edited. They're encrypted where
your operating system provides a keyring, and written with restricted file permissions and a
visible warning where it doesn't.

## Notifications, tray, and close vs quit

When a task needs your input, the desktop app raises a native OS notification, using the
same wording and the same on/off switches as the notifications you'd get in a browser tab
(Settings → Notifications). The app's own in-window notification channel is switched off, so
you never get the same alert twice. If you open Settings → Notifications inside the desktop
app, its "Browser notifications" and "Push notifications" fields both report that native
notifications already cover this; neither offers to enable a second channel. Clicking a
notification raises the window and opens the task it's about.

The dock or taskbar badge shows how many tasks across all your instances are waiting on you,
kept in sync as tasks are answered or added. The tray icon carries the same count and its
menu offers Show, the Instance submenu (see Instances above), Check for updates, and Quit.

Closing the window, its close button or Cmd/Ctrl+W, hides it to the tray. It does not quit:
the server keeps running and any turns in progress keep going. Quitting for real,
Quit from the tray menu or application menu, or Cmd/Ctrl+Q, waits for active turns to settle,
stops the server, and exits. On macOS, clicking the dock icon again brings back the same
hidden window with your work exactly as you left it. On a desktop with no tray or status area
for an icon to live in, closing the window quits the app instead.

## Updates

The app checks for updates about 45 seconds after boot, then every 6 hours after that. A new
version downloads automatically in the background; it never installs itself without asking.

Once an update is ready, you'll see an OS notification, the tray menu's item changes to
"Restart to update to *X.Y.Z*", and the same item appears in the application menu. Clicking
it opens a dialog with **Restart and update** and **Later**, telling you how many turns are
currently running: the restart always waits for in-flight turns to be stopped and settled
before it installs anything. Clicking **Later** just postpones the prompt; the app doesn't
nag again until the next scheduled check finds the same or a newer version. **Check for
updates…** is available in both menus at any time. If a check or install fails outright, the
app raises a notification saying it can't update itself, with a link to the releases page so
you can grab the build by hand.

Update support differs by platform and build:

| Platform | Updates? |
|-|-|
| Windows installer | Yes, whether or not it's signed |
| macOS | Only if the build is signed and running from `/Applications`; otherwise the menu says updates need a manual download |
| Linux AppImage | Yes, replaces itself in place |
| Linux `.deb` | No, deliberately: the menu says "Updates come from your package manager" |
| A checkout run with `npm start` | No |

Set `CALANDRIA_DESKTOP_AUTO_UPDATE=off` (documented in `../.env.example`) to stop the app
from checking at all.

If an update doesn't behave as expected, the app's logs are the place to look:

| Platform | Log path |
|-|-|
| macOS | `~/Library/Logs/Calandria/main.log` |
| Linux | `~/.config/Calandria/logs/main.log` |
| Windows | `%APPDATA%\Calandria\logs\main.log` |

Logs rotate to `main.old.log` at 5 MB.

## Known limitations

The desktop shell only wraps a server running natively on the machine you launch it on; it
does not reach into WSL2. If your Calandria server runs inside a WSL2 distro, don't point the
desktop app at it. Instead run `npm start` inside the distro and open
`http://127.0.0.1:3000` in an ordinary Windows browser, which reaches it the same way.
Wherever that server keeps its data, keep `CALANDRIA_DB_DIR` and `CALANDRIA_WORKTREES_DIR` on
the distro's own filesystem, ext4, never under `/mnt/c`: that path is 9p underneath, and
SQLite's write-ahead log corrupts on it.

No platform's app currently notices a real system shutdown or logout; only an explicit Quit,
or closing the window on a desktop with no tray, triggers the drain that settles running
turns. Turning off your computer while Calandria is mid-turn does not give it a chance to
finish cleanly.

On macOS, an app launched by double-clicking gets a minimal PATH from the system. Your
terminal's PATH is not included, so tools installed through Homebrew or a Node version manager
could otherwise be invisible to the built-in terminal panel. The desktop app detects and
repairs this on its own; it is not something you normally need to configure. If you need to
force the behavior, `CALANDRIA_DESKTOP_PATH_PROBE=always` runs the repair on every launch and
`=off` disables it (documented in `../.env.example`); the default, `auto`, is right for
ordinary use.

The window doesn't remember its size or position between launches, and `calandria://` deep
links aren't wired up yet.

On Linux, a notification only shows if something on the system owns the standard notification
service (most desktop environments provide this by default). On a session with no notification
daemon running at all, each notification attempt can freeze the whole app for up to 25 seconds
instead of silently doing nothing.

Unsigned or self-built copies still run correctly; they just come with the OS warnings
covered in Installing above. See `../desktop/README.md` for what it takes to produce fully
signed builds on every platform.
