/* The desktop app's instance list — which server the window is attached to.
 *
 * Phase 1 of docs/superpowers/specs/2026-09-02-remote-instances-design.md. The
 * shell used to have exactly one server: the pair of sidecars supervisor.js
 * spawns on loopback. This file turns that into ONE ENTRY IN A LIST, so the
 * same window can be pointed at a Calandria running somewhere else.
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
    if (entry.kind !== "url") continue; // "ssh" arrives in phase 2
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
    label: i.kind === "local" ? i.name : `${i.name} — ${new URL(i.url).host}`,
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
  activeInstance,
  addUrlInstance,
  compareVersions,
  defaultState,
  findInstance,
  instanceMenuItems,
  instancesFilePath,
  loadInstances,
  newInstanceId,
  normalizeInstanceUrl,
  normalizeState,
  partitionFor,
  removeInstance,
  saveInstances,
  serverTooOld,
  setActive,
  versionBannerText,
  windowTitle,
};
