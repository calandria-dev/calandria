# Remote instances — design (spike)

Date: 2026-09-02
Status: proposal. Nothing in this document is implemented.

The question: VS Code can attach its UI to a remote machine. Calandria now ships as a
self-hosted server and as a desktop app. What is the right way to give it the same ability?

The short answer: the server half of the VS Code split already exists. Every Calandria server
is a "remote" in the VS Code sense, and the browser is already the thin client. The only
surface that assumes the server is local is the desktop app, so remote instances is a desktop
feature: let the native shell attach to a server it did not spawn, over a plain URL or over an
SSH port-forward, with the instance list kept on the client. No control plane, no server
install from the client, and almost no server change.

## What Calandria already is

VS Code Remote works by moving the editor's backend to the other machine and leaving the UI
local. Calandria was built with that split from the start:

- The server owns all state. Turns run detached in the server process (`lib/runner.ts`),
  transcripts live in the server's SQLite, worktrees live on the server's disk, and the agent
  logins are read from the server host's `~/.claude` and `~/.codex`
  (`lib/agents/connections.ts`). A client that disconnects loses nothing.
- The client is a browser. Every URL it builds is relative (`app/shell/api.ts`,
  `useTaskStream.ts`, `useGlobalEvents.ts`). The one absolute origin is the terminal's
  WebSocket, taken from `window.__PUBLIC_BASE_URL` or `location.origin`
  (`app/Terminal.tsx:122`).
- Reaching a server over the network is documented in `docs/SELF_HOSTING.md`: an HTTPS reverse
  proxy on the LAN, a Cloudflare Tunnel with Access, or an SSH port-forward.

So for the web app, a remote instance is a bookmark. There is nothing to add.

The desktop app (`desktop/`) is different. It is an Electron shell that spawns `server.js` and
`pty-server.js` as children (`desktop/supervisor.js:526`), loads `http://127.0.0.1:<port>` in
its window (`desktop/main.js:238`), and subscribes to `/api/events` from the main process for
OS notifications, the tray and the badge count (`desktop/notifier.js`). The server's own
`SERVICE_TOKEN` is sent on those main-process requests (`desktop/main.js:1027`,
`desktop/notifier.js:210`). There is no setting, env var or menu item that points the window
anywhere else. `docs/DESKTOP_APP.md` states this: the desktop app does not work remotely.

## Three models, one chosen

### 1. Remote-SSH clone: install and launch the server over SSH from the client

This is what VS Code Remote-SSH does. Rejected as the primary path:

- Installing Calandria on a host is the self-hosting story: Node 22, native modules
  (`better-sqlite3`, `node-pty`), the published image, an env file, a data directory. Doing it
  from a desktop client duplicates `docs/SELF_HOSTING.md` in JavaScript and takes on every
  distro's packaging.
- The agent login on the remote host is an interactive OAuth flow in a terminal. The client
  cannot do it silently. Once a server is up, though, the user can run `claude login` inside
  Calandria's own terminal drawer, since that shell already runs on the server host.
- A server tied to the client's session lifecycle is the wrong shape. Calandria turns are meant
  to keep running after the tab closes, and one process per database is enforced
  (`lib/db-lock.mjs`). The server should be a service on the remote, started by the operator.

What survives from this model is the transport: an SSH port-forward is cheap, needs no exposed
port and no tunnel product, and turns the user's existing SSH keys into the credential.

### 2. Attach the desktop shell to a URL, directly or through an SSH forward (chosen)

The desktop app keeps a list of instances. "This computer" is the supervisor-managed server it
runs today. Any other instance is an origin the shell attaches to. Two transports:

- **direct**: an `https://` origin behind Cloudflare Access, or a LAN origin the operator
  already allows for browsers.
- **ssh**: the desktop spawns the user's `ssh` binary with a local port-forward to the remote
  server's loopback port, then attaches to `http://127.0.0.1:<localPort>`. The server needs no
  change: local mode allows loopback on any port (`lib/auth/local-origin.mjs:10`), and the
  pty sidecar's peer is `server.js` on the remote's loopback, so `isLoopbackPeer` passes.

### 3. Fleet: one server aggregating many instances

One UI showing tasks from many servers needs a server that knows about other servers. `CLAUDE.md`
rules this out: no hosted, fleet or billing features, no first-party identity. A client-side
list of saved origins is not a control plane, and the only cross-instance view this design
allows is a client-side sum of "needs you" counts.

## Design

### Instance model

A JSON file next to the existing desktop env file (`~/.config/calandria/instances.json`):

```json
{
  "active": "local",
  "instances": [
    { "id": "local", "kind": "local", "name": "This computer" },
    { "id": "a1f3", "kind": "url", "name": "Lab", "url": "https://calandria.example.com" },
    { "id": "9c2e", "kind": "ssh", "name": "Build box", "ssh": { "host": "build", "remotePort": 3000 } }
  ]
}
```

`local` is always present and is the only instance that carries a `SERVICE_TOKEN`. The
supervisor becomes one attach strategy among three rather than the app's spine.

### Attach flow

| kind | steps |
|-|-|
| local | `supervisor.start()` as today, then load its ready URL. |
| url | Load the URL. Before showing the window, `GET /api/version` for the handshake below. |
| ssh | Spawn `ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort> <host>`, wait for the local port to accept, then proceed as `url` on `http://127.0.0.1:<localPort>`. On `ssh` exit, show the loading page with the last stderr lines and reconnect with backoff. |

Shell out to the user's `ssh` rather than embedding an SSH library. Their config, agent, jump
hosts, `ControlMaster` and hardware keys already work there. `BatchMode=yes` is required
because a GUI has no tty to answer a password or 2FA prompt in. A host that needs one is told
to set up a key or a `ControlMaster` socket first.

The handshake is the one compatibility point. The shell declares a `minServerVersion`; an older
server gets a banner naming both versions and still loads. The server never needs to know the
client version because the web UI it serves is always its own.

### Auth per transport

- **ssh**: SSH is the credential. The remote server stays bound to loopback in local mode, the
  window's `Host` is loopback, and the origin gate passes without configuration.
- **url, Cloudflare Access**: the Electron window is a browser, so the Access login completes
  in it and `CF_Authorization` lands in the session cookie jar. Give each remote instance its
  own persistent partition (`partition: "persist:instance-<id>"`) so cookies do not bleed
  between instances and "sign out" is deleting the partition. The notifier must stop using
  `globalThis.fetch` (`desktop/notifier.js:187`) and fetch through that instance's session so
  the cookie rides along. For an unattended notifier without a browser login, an Access
  service-token pair can be stored with Electron's `safeStorage` and sent as
  `CF-Access-Client-Id` / `CF-Access-Client-Secret`; the edge mints the JWT, so
  `lib/cf-access.mjs` needs no change.
- **url, LAN local mode**: the page is loaded from the remote origin, so `Origin` equals
  `Host` and the request passes if the operator listed that origin in
  `CALANDRIA_ALLOWED_ORIGINS` or `PUBLIC_BASE_URL`. That is the existing browser requirement.
  There is no login in this mode and this design does not invent one: attaching to a plain
  LAN instance has the same trust level as a browser tab on it.
- The local `SERVICE_TOKEN` must never leave the machine. Today it is read from the supervisor
  env for every main-process request; it becomes a property of the `local` instance only.

### Native features per instance

- **Notifications and badge**: one `AppEvents` subscriber for the active instance in phase 1.
  In phase 3, one per saved instance, so the badge sums "needs you" across instances and a
  notification names the instance it came from. That is the whole cross-instance surface,
  and it lives in the client.
- **Tray and app menu**: a radio list of instances, "Add instance…", "Manage instances…".
  Switching tears down the current transport (nothing for `url`, the `ssh` child for `ssh`,
  nothing for `local`, whose server keeps running as it does on hide-to-tray today).
- **Window title**: `<instance name> · Calandria`. The server gains an optional
  `CALANDRIA_INSTANCE_NAME` (`lib/config.ts`, `.env.example`), returned by `/api/version` and
  shown in the web titlebar too, so two browser tabs on two instances are distinguishable. The
  desktop uses it as the default name when adding an instance by URL.
- **Auto-update**: updates the shell only. Servers are updated where they run.
- **Deep link** `calandria://attach?url=…`: later, once the instance list exists.

### Server-side changes

The design works with zero server changes. Two small ones make it better:

1. `CALANDRIA_INSTANCE_NAME`, surfaced on `/api/version` and in the titlebar.
2. A "Connecting the desktop app" section in `docs/SELF_HOSTING.md` covering the three
   transports and what each expects the operator to have configured.

### Explicitly not built

- Installing or launching a Calandria server on a remote host from the client.
- A server-side inbox or task list spanning instances.
- Any login for local mode. The two auth modes in `lib/auth/` stay the only two.

## Phasing

| phase | scope |
|-|-|
| 1 | Instance list file, `url` kind, per-instance partition, notifier fetching through the instance session, version handshake, `SERVICE_TOKEN` scoped to `local`. Tray and menu switcher. Desktop only. |
| 2 | `ssh` kind: spawn, port wait, stderr surfacing, reconnect. |
| 3 | Multi-instance notifier and badge sum, `CALANDRIA_INSTANCE_NAME`, self-hosting docs, desktop e2e that boots a second server on another port and attaches by URL. |

## Risks and open points

- **Identity providers and embedded browsers.** Some IdPs refuse logins from WebView-like
  user agents. Electron's default UA is usually accepted. If not, set a Chrome UA on the
  instance partition. Verify against the user's IdP before phase 1 ships.
- **Exposed services do not traverse an SSH forward.** `lib/service-router.mjs` dispatches on
  the `<slug>--<appHost>` hostname, and a forwarded loopback port has no such hostnames. Over
  `ssh`, the Services panel's links need their own forward, or the user opens them in a browser
  through whatever the remote already exposes. Over `url` they work as in a browser.
- **HMR and dev servers**: not relevant. Remote instances are production servers.
- **Two windows, two instances**: out of scope. One window, one active instance, like VS Code's
  one-remote-per-window rule, and simpler than it because switching is a page load.
