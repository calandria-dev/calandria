/* The desktop app's instance list — which server the window is attached to.
 *
 * Phases 1 and 2 of docs/superpowers/specs/2026-09-02-remote-instances-design.md.
 * The shell used to have exactly one server: the pair of sidecars supervisor.js
 * spawns on loopback. This file turns that into ONE ENTRY IN A LIST, so the
 * same window can be pointed at a Calandria running somewhere else.
 *
 * THREE KINDS. `local` is the supervisor's pair. `url` is an origin reached
 * over the network as any browser would. `ssh` is a `url` whose origin does not
 * exist until an `ssh -L` forward is running — see ssh-tunnel.js, which owns
 * everything about that; this file only holds `{ host, remotePort, localPort? }`
 * and the rules for reading one out of what a person typed.
 *
 * Everything here is plain data and file IO, with no `electron` require, for
 * the reason supervisor.js and env-file.js are the same shape: the risky half
 * has to be verifiable from `node desktop/test-supervisor.js` on a box with no
 * display. main.js holds the Electron half — sessions, windows, menus.
 *
 * THE FILE. `~/.config/calandria/instances.json`, beside the env file
 * env-file.js reads and resolved the same way (CALANDRIA_INSTANCES_FILE wins,
 * then XDG_CONFIG_HOME, then ~/.config), so one documented directory holds
 * everything the desktop app keeps outside Electron's own user-data.
 *
 * TWO INVARIANTS, both enforced on every load and every write, because a
 * hand-edited or half-written file must never leave the app with nowhere to go:
 *
 *   1. `local` always exists, is always first, and is always kind "local".
 *      It is the supervisor-managed server, and it is the only instance that
 *      is allowed to see SERVICE_TOKEN (main.js's `serviceTokenFor`). A file
 *      that omits it, renames its kind, or lists it twice is repaired rather
 *      than rejected.
 *   2. `active` always names an instance that is present. Anything else falls
 *      back to `local`.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DEFAULT_REMOTE_PORT } = require("./ssh-tunnel");

const LOCAL_ID = "local";
const LOCAL_NAME = "This computer";

/**
 * The oldest server this shell knows how to drive.
 *
 * The handshake is one-directional on purpose (see the spec): the server never
 * learns the client's version, because the web UI it serves is always its own.
 * All this number can do is warn — an older server still LOADS, with a banner
 * naming both versions, because the alternative is a desktop app that refuses
 * to open a working Calandria over a number.
 *
 * Bump it only when the shell starts requiring something a server has to
 * provide. Today nothing does, so it sits at the release the instance list
 * shipped in.
 */
const MIN_SERVER_VERSION = "0.7.0";

/**
 * Where the instance list lives. Mirrors env-file.js's `envFilePath` exactly,
 * including the one-path-on-every-platform rule and the env override, so the
 * two desktop config files are never in two places.
 */
function instancesFilePath(env = process.env) {
  if (env.CALANDRIA_INSTANCES_FILE) return env.CALANDRIA_INSTANCES_FILE;
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "calandria", "instances.json");
}

function localInstance(name) {
  return { id: LOCAL_ID, kind: "local", name: name || LOCAL_NAME };
}

/** The empty state — what a machine that has never added an instance has. */
function defaultState() {
  return { active: LOCAL_ID, instances: [localInstance()] };
}

const ID_RE = /^[a-z0-9]{1,32}$/;

/**
 * Coerce whatever was on disk into a state that satisfies both invariants.
 *
 * Repairs rather than throws, all the way down: this runs on a file a user is
 * invited to edit by hand, and the failure mode of being strict is a desktop
 * app that will not start because of a stray comma.
 */
function normalizeState(raw) {
  const out = [];
  const seen = new Set();
  let localName = null;
  const list = Array.isArray(raw?.instances) ? raw.instances : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
    if (!ID_RE.test(id) || seen.has(id)) continue;
    if (id === LOCAL_ID) {
      // The local entry carries nothing but a name — its URL is whatever the
      // supervisor binds this launch, which no file can know in advance.
      seen.add(id);
      localName = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null;
      continue;
    }
    if (entry.kind === "ssh") {
      let ssh;
      try {
        ssh = normalizeSshTarget(entry.ssh);
      } catch {
        continue;
      }
      seen.add(id);
      out.push({
        id,
        kind: "ssh",
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : ssh.host,
        ssh,
      });
      continue;
    }
    if (entry.kind !== "url") continue;
    let url;
    try {
      url = normalizeInstanceUrl(entry.url);
    } catch {
      continue;
    }
    seen.add(id);
    out.push({
      id,
      kind: "url",
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : url,
      url,
    });
  }
  const instances = [localInstance(localName), ...out];
  const wanted = typeof raw?.active === "string" ? raw.active.trim().toLowerCase() : LOCAL_ID;
  const active = instances.some((i) => i.id === wanted) ? wanted : LOCAL_ID;
  return { active, instances };
}

/**
 * Accept what a person types into "Add instance" and return the origin to
 * attach to, or throw with a sentence that can be shown in the dialog.
 *
 * A bare host is read as https, because the two things this kind is for are a
 * tunnel hostname and a LAN box behind TLS, and defaulting to http would send
 * an Access cookie over plaintext on a typo. Someone who really means http
 * says so. The path is dropped: every URL the client builds is relative to the
 * origin (app/shell/api.ts), so a saved path would only ever be wrong.
 */
function normalizeInstanceUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("Enter the address of the Calandria server.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`"${raw}" is not a valid address.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http:// and https:// addresses can be attached to.");
  }
  if (!u.hostname) throw new Error(`"${raw}" has no host.`);
  return u.origin;
}

/*
 * An ssh destination is `[user@]host`, where `host` is as likely to be an alias
 * out of the user's ~/.ssh/config as a hostname — which is most of why this
 * kind exists at all, since an alias carries the jump host, the identity file
 * and the ControlMaster socket with it.
 *
 * The pattern is a whitelist rather than a blacklist, and the ONE rule that is
 * about safety rather than typos is that it cannot start with `-`: the value
 * ends up in an argv this app builds, and a "host" named `-oProxyCommand=…`
 * would be read by ssh as an option. There is no shell in the path (spawn takes
 * an array), so quoting is not the exposure; argument position is.
 */
const SSH_HOST_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*)(?:@[A-Za-z0-9_](?:[A-Za-z0-9_.-]*))?$/;

function normalizePort(value, { field, fallback = null }) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== null) return fallback;
    throw new Error(`Enter a ${field}.`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`"${value}" is not a valid ${field}.`);
  return n;
}

/**
 * Coerce an `ssh` instance's target into `{ host, remotePort, localPort? }`, or
 * throw with a sentence the dialog can show.
 *
 * `remotePort` is the port CALANDRIA listens on over there, not sshd's — the
 * ssh port belongs in the user's ~/.ssh/config with everything else about how
 * to reach the host. `localPort` is optional and is the escape hatch for
 * someone who wants a fixed origin; leaving it out lets the app pick a free one
 * (ssh-tunnel.js's `pickLocalPort`).
 */
function normalizeSshTarget(input) {
  const raw = input && typeof input === "object" ? input : {};
  const host = String(raw.host ?? "").trim();
  if (!host) throw new Error("Enter the SSH host to forward through.");
  if (!SSH_HOST_RE.test(host)) {
    throw new Error(`"${host}" is not a host ssh can be pointed at. Use [user@]host, or a Host alias from ~/.ssh/config.`);
  }
  const target = { host, remotePort: normalizePort(raw.remotePort, { field: "remote port", fallback: DEFAULT_REMOTE_PORT }) };
  if (raw.localPort !== undefined && raw.localPort !== null && raw.localPort !== "") {
    target.localPort = normalizePort(raw.localPort, { field: "local port" });
  }
  return target;
}

/**
 * Read one typed address into the instance it describes.
 *
 * One field rather than a kind picker, because the two kinds ARE one question —
 * where is the server — and the scheme is how every other tool spells the
 * answer. `ssh://` is the whole of the syntax: `ssh://build`, `ssh://me@build`,
 * `ssh://build:3000` when the remote Calandria is not on the default port.
 */
function parseInstanceAddress(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("Enter the address of the Calandria server.");
  if (/^ssh:\/\//i.test(raw)) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`"${raw}" is not a valid ssh:// address.`);
    }
    const host = `${u.username ? `${decodeURIComponent(u.username)}@` : ""}${u.hostname}`;
    const ssh = normalizeSshTarget({ host, remotePort: u.port || DEFAULT_REMOTE_PORT });
    return { kind: "ssh", ssh };
  }
  return { kind: "url", url: normalizeInstanceUrl(raw) };
}

/**
 * How an instance is written down: the second line of a manage-dialog row, the
 * tail of a menu label, the subheading on the boot screen. One function so the
 * three never disagree about what an `ssh` instance is called.
 */
function instanceAddress(instance) {
  if (!instance) return "";
  if (instance.kind === "local") return "Managed by this app";
  if (instance.kind === "ssh") return `ssh://${instance.ssh.host}:${instance.ssh.remotePort}`;
  return instance.url;
}

/** A short id that is not already taken. Four hex chars, like the spec's file. */
function newInstanceId(state, random = Math.random) {
  const taken = new Set(state.instances.map((i) => i.id));
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = Math.floor(random() * 0xffff)
      .toString(16)
      .padStart(4, "0");
    if (!taken.has(id) && id !== LOCAL_ID) return id;
  }
  // Exhausting 65k ids is not a real case; falling back to a longer one beats
  // returning a duplicate that would silently share another instance's cookies.
  return `x${Date.now().toString(36)}`.slice(0, 32);
}

/** Add a `url` instance. Returns `{ state, instance }`; throws on a bad URL. */
function addUrlInstance(state, { name, url }, random = Math.random) {
  const origin = normalizeInstanceUrl(url);
  const id = newInstanceId(state, random);
  const label = String(name ?? "").trim() || new URL(origin).host;
  const instance = { id, kind: "url", name: label, url: origin };
  return { state: { active: state.active, instances: [...state.instances, instance] }, instance };
}

/** Add an `ssh` instance. Returns `{ state, instance }`; throws on a bad target. */
function addSshInstance(state, { name, host, remotePort, localPort }, random = Math.random) {
  const ssh = normalizeSshTarget({ host, remotePort, localPort });
  const id = newInstanceId(state, random);
  const label = String(name ?? "").trim() || ssh.host;
  const instance = { id, kind: "ssh", name: label, ssh };
  return { state: { active: state.active, instances: [...state.instances, instance] }, instance };
}

/** Add whichever kind the typed address describes. The dialog's one entry point. */
function addInstance(state, { name, address }, random = Math.random) {
  const parsed = parseInstanceAddress(address);
  if (parsed.kind === "ssh") return addSshInstance(state, { name, ...parsed.ssh }, random);
  return addUrlInstance(state, { name, url: parsed.url }, random);
}

/**
 * The name `addInstance` would derive for this instance from its address alone
 * — the URL's host, or the ssh target's host. `null` for `local`, which has a
 * fixed name and no address.
 */
function derivedNameFor(instance) {
  if (!instance || instance.kind === "local") return null;
  if (instance.kind === "ssh") return instance.ssh?.host || null;
  try {
    return new URL(instance.url).host;
  } catch {
    return null;
  }
}

/**
 * Take the name the SERVER reports for itself (CALANDRIA_INSTANCE_NAME, off the
 * `/api/version` handshake), but only over a name nobody chose.
 *
 * An instance added by URL with the name field left blank is labelled with its
 * host — `calandria.example.com`, which is the address again rather than a
 * name. The server usually knows better, and the handshake that decides whether
 * to warn about an old version already has the answer in its hand, so the first
 * attach adopts it.
 *
 * The rule is deliberately narrow. A name the user TYPED is theirs, and a
 * server that renames itself must not overwrite it; the check is that the
 * current name is still exactly what the address would have derived. That also
 * makes this idempotent: once adopted, the name no longer matches the derived
 * one, so a later attach leaves it alone even if the server's name changes.
 * Returns the state unchanged when there is nothing to do, so the caller can
 * compare by identity to decide whether to save.
 */
function adoptServerName(state, id, serverName) {
  const name = String(serverName ?? "").trim();
  if (!name) return state;
  const target = findInstance(state, id);
  if (!target || target.name === name) return state;
  if (target.name !== derivedNameFor(target)) return state;
  return {
    active: state.active,
    instances: state.instances.map((i) => (i.id === id ? { ...i, name } : i)),
  };
}

/**
 * Drop an instance. `local` is never removable — it is the way back from every
 * other one, and the app has to have somewhere to go.
 */
function removeInstance(state, id) {
  if (id === LOCAL_ID) return state;
  const instances = state.instances.filter((i) => i.id !== id);
  const active = instances.some((i) => i.id === state.active) ? state.active : LOCAL_ID;
  return { active, instances };
}

function setActive(state, id) {
  if (!state.instances.some((i) => i.id === id)) return state;
  return { active: id, instances: state.instances };
}

function findInstance(state, id) {
  return state.instances.find((i) => i.id === id) || null;
}

function activeInstance(state) {
  return findInstance(state, state.active) || state.instances[0];
}

/**
 * The Electron session partition an instance's window and its notifier both
 * use. `null` for `local`, which stays on the default session so nothing about
 * the existing single-instance shell changes.
 *
 * Everything else gets its OWN persistent partition, and that is the whole
 * reason this function exists: a Cloudflare Access login lands `CF_Authorization`
 * in a cookie jar, and two instances behind the same Access team sharing one jar
 * would send each other's assertion. A partition per instance also makes "sign
 * out" a single call — delete the partition's storage — instead of a guess about
 * which cookies belonged to whom.
 */
function partitionFor(instance) {
  return !instance || instance.kind === "local" ? null : `persist:instance-${instance.id}`;
}

/** `<instance name> · Calandria`, the window title for every kind. */
function windowTitle(instance) {
  const name = instance?.name?.trim();
  return name ? `${name} · Calandria` : "Calandria";
}

/**
 * The radio list the tray and the app menu both draw. Returned as data so the
 * ordering and the checked-ness are testable without a display.
 */
function instanceMenuItems(state) {
  return state.instances.map((i) => ({
    id: i.id,
    label: i.kind === "local" ? i.name : `${i.name} — ${i.kind === "ssh" ? i.ssh.host : new URL(i.url).host}`,
    checked: i.id === state.active,
  }));
}

/* ------------------------------------------------------------------------- *
 * Version handshake.
 * ------------------------------------------------------------------------- */

/**
 * Compare two dotted numeric versions. Prerelease and build suffixes are cut
 * before comparing, so `0.8.0-rc.1` reads as `0.8.0` — deliberately generous,
 * because the only thing this decides is whether to show a warning, and
 * nagging somebody running a release candidate of a NEWER server is the wrong
 * error to make.
 *
 * Returns -1, 0 or 1, or `null` when either side is not a version at all.
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+(?:\.\d+)*)/.exec(String(v ?? "").trim());
    return m ? m[1].split(".").map(Number) : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * Is this server older than the shell needs?
 *
 * An UNREADABLE version is not old. A fork, a dev build, an `unknown` from a
 * checkout with no tag — none of those is evidence of anything, and warning on
 * them would make the banner meaningless on exactly the installs most likely
 * to see it.
 */
function serverTooOld(serverVersion, minVersion = MIN_SERVER_VERSION) {
  return compareVersions(serverVersion, minVersion) === -1;
}

/** The sentence the banner shows. Names both versions, as the spec requires. */
function versionBannerText({ instanceName, serverVersion, minVersion = MIN_SERVER_VERSION }) {
  return (
    `${instanceName || "This instance"} is running Calandria ${serverVersion}. ` +
    `This desktop app expects ${minVersion} or newer, so some things may not work. ` +
    `Update the server where it runs.`
  );
}

/* ------------------------------------------------------------------------- *
 * Persistence.
 * ------------------------------------------------------------------------- */

/**
 * Read the list. Never throws — a missing file is the common case (nobody has
 * added an instance yet) and an unreadable one must not stop the app from
 * launching, so both come back as the default state with `found: false`.
 */
function loadInstances({ env = process.env, file = null } = {}) {
  const p = file || instancesFilePath(env);
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return { path: p, found: true, state: normalizeState(raw) };
  } catch (err) {
    return { path: p, found: false, state: defaultState(), error: err?.code === "ENOENT" ? null : err };
  }
}

/**
 * Write the list, atomically: a truncated JSON file here is a desktop app that
 * boots to a repaired-but-wrong instance list, and the window is the only place
 * that could report it. Normalized on the way out as well as the way in, so the
 * file on disk is always something this loader would accept unchanged.
 */
function saveInstances(state, { env = process.env, file = null } = {}) {
  const p = file || instancesFilePath(env);
  const normalized = normalizeState(state);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, p);
  return { path: p, state: normalized };
}

module.exports = {
  LOCAL_ID,
  LOCAL_NAME,
  MIN_SERVER_VERSION,
  DEFAULT_REMOTE_PORT,
  activeInstance,
  addInstance,
  addSshInstance,
  addUrlInstance,
  adoptServerName,
  compareVersions,
  defaultState,
  derivedNameFor,
  findInstance,
  instanceAddress,
  instanceMenuItems,
  instancesFilePath,
  loadInstances,
  newInstanceId,
  normalizeInstanceUrl,
  normalizeSshTarget,
  normalizeState,
  parseInstanceAddress,
  partitionFor,
  removeInstance,
  saveInstances,
  serverTooOld,
  setActive,
  versionBannerText,
  windowTitle,
};
