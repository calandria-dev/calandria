import pkg from "@/package.json";
import { INSTANCE_NAME } from "@/lib/config";
import { readEnv } from "@/lib/env.mjs";
import { getSetting, setSetting } from "@/lib/store";
import { publishGlobal } from "@/lib/events";
import installMethod from "./installMethod";
import { compareVersions, isNewer, parseVersion } from "./semver";
import { trimReleaseNotes } from "./notes";
import type { ReleaseEntry, UpdateState } from "./types";

/**
 * The server's release check.
 *
 * One request per instance every six hours, plus one per press of "Check now".
 * Browser tabs never call github.com: the page reads GET /api/updates, which
 * serves what this module cached. The result is also persisted in the settings
 * table under `update_state`, so a restart shows the pill on the first page
 * load, with no wait for the first check.
 *
 * The request carries the running version in a User-Agent header and nothing
 * else about the instance.
 *
 * Kept free of the agent SDKs (database, event bus and fetch only) so route
 * entries can import it synchronously; pinned by tests/importGraph.test.ts.
 */

const DEFAULT_FEED = "https://api.github.com/repos/calandria-dev/calandria/releases?per_page=20";
const FETCH_TIMEOUT_MS = 10_000;
const FIRST_CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What survives a restart. Everything else in UpdateState is recomputed. */
type Persisted = {
  latest: UpdateState["latest"];
  releases: ReleaseEntry[];
  checkedAt: string | null;
  error: string | null;
};

const EMPTY: Persisted = { latest: null, releases: [], checkedAt: null, error: null };

type CheckerState = {
  timer: ReturnType<typeof setInterval> | null;
  first: ReturnType<typeof setTimeout> | null;
  cache: Persisted | null;
  inflight: Promise<UpdateState> | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __calandriaUpdates: CheckerState | undefined;
}

function state(): CheckerState {
  globalThis.__calandriaUpdates ??= { timer: null, first: null, cache: null, inflight: null };
  return globalThis.__calandriaUpdates;
}

/** A plain string map, so a test can hand over a whole environment as a literal. */
export type EnvLike = Record<string, string | undefined>;

export type UpdateCheckDeps = {
  fetch?: typeof fetch;
  now?: () => Date;
  env?: EnvLike;
  currentVersion?: string;
};

/**
 * An injected env is the whole environment, so a test cannot be reached by an
 * ambient variable. The real one goes through readEnv, which also answers to
 * the legacy ORCH_ spelling.
 */
function readFrom(env: EnvLike | undefined, name: string): string {
  return String((env ? env[name] : readEnv(name)) ?? "").trim();
}

/**
 * Whether this instance checks at all. Layered: the operator's env var wins,
 * then the switch in Settings. Off at either level hides the pill and stops
 * the request.
 */
export function updateCheckEnabled(env?: EnvLike): boolean {
  const raw = readFrom(env, "CALANDRIA_UPDATE_CHECK").toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return false;
  return getSetting("update_check") !== "off";
}

function feedUrl(env?: EnvLike): string {
  return readFrom(env, "CALANDRIA_UPDATE_FEED_URL") || DEFAULT_FEED;
}

function currentOf(deps?: UpdateCheckDeps): UpdateState["current"] {
  return {
    version: deps?.currentVersion ?? pkg.version,
    sha: readEnv("CALANDRIA_GIT_SHA") ?? "unknown",
    builtAt: readEnv("CALANDRIA_BUILT_AT") ?? "unknown",
    installMethod: installMethod(),
    instanceName: INSTANCE_NAME || null,
  };
}

function loadPersisted(): Persisted {
  const raw = getSetting("update_state");
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      latest: parsed.latest ?? null,
      releases: Array.isArray(parsed.releases) ? parsed.releases : [],
      checkedAt: parsed.checkedAt ?? null,
      error: parsed.error ?? null,
    };
  } catch {
    // A settings row we wrote ourselves, so this only happens if somebody
    // edited the database by hand. Start over, and keep serving.
    return EMPTY;
  }
}

function compose(p: Persisted, deps?: UpdateCheckDeps): UpdateState {
  const current = currentOf(deps);
  return {
    enabled: updateCheckEnabled(deps?.env),
    current,
    latest: p.latest,
    available: !!p.latest && isNewer(p.latest.version, current.version),
    releases: p.releases,
    // Read at call time so a Skip in another tab is never served stale.
    dismissedVersion: getSetting("update_dismissed") || null,
    checkedAt: p.checkedAt,
    error: p.error,
  };
}

/** The cached state, falling back to what the last process persisted. */
export function getUpdateState(deps?: UpdateCheckDeps): UpdateState {
  const s = state();
  s.cache ??= loadPersisted();
  return compose(s.cache, deps);
}

/** Test seam: drop the in-memory cache so the next read comes off the row. */
export function resetUpdateCache(): void {
  const s = state();
  s.cache = null;
  s.inflight = null;
}

type GithubRelease = {
  tag_name?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  published_at?: string | null;
};

function parseFeed(payload: unknown, currentVersion: string): Pick<Persisted, "latest" | "releases"> {
  const rows = Array.isArray(payload) ? (payload as GithubRelease[]) : [];
  const usable = rows
    // Drafts are unpublished and pre-releases are not what a tagged install
    // should be told to move to. The check follows tagged releases only.
    .filter((r) => !r.draft && !r.prerelease && parseVersion(r.tag_name) !== null)
    .map((r) => ({
      version: parseVersion(r.tag_name)!,
      tag: String(r.tag_name),
      url: r.html_url || "",
      publishedAt: r.published_at || "",
      notes: trimReleaseNotes(r.body),
    }))
    .map((r) => ({ ...r, versionText: `${r.version.major}.${r.version.minor}.${r.version.patch}` }))
    .sort((a, b) => compareVersions(b.versionText, a.versionText));

  const newest = usable[0];
  return {
    latest: newest
      ? { version: newest.versionText, tag: newest.tag, url: newest.url, publishedAt: newest.publishedAt }
      : null,
    releases: usable
      .filter((r) => isNewer(r.versionText, currentVersion))
      .map((r) => ({ version: r.versionText, url: r.url, publishedAt: r.publishedAt, notes: r.notes })),
  };
}

async function fetchOnce(deps: UpdateCheckDeps | undefined, prev: Persisted): Promise<Persisted> {
  const doFetch = deps?.fetch ?? fetch;
  const now = deps?.now ?? (() => new Date());
  const currentVersion = deps?.currentVersion ?? pkg.version;
  const checkedAt = now().toISOString();
  try {
    const res = await doFetch(feedUrl(deps?.env), {
      headers: { accept: "application/vnd.github+json", "user-agent": `calandria/${currentVersion}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      // A rate limit or an outage. Keep what the last good check found: a
      // stale pill is a better failure than a pill that disappears.
      return { ...prev, checkedAt, error: `GitHub returned ${res.status}` };
    }
    const parsed = parseFeed(await res.json(), currentVersion);
    return { ...parsed, checkedAt, error: null };
  } catch (e) {
    return { ...prev, checkedAt, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Ask the feed now. One request in flight at a time: a second caller awaits
 * the first one's promise, so a burst of "Check now" presses is one request.
 */
export async function runUpdateCheck(deps?: UpdateCheckDeps): Promise<UpdateState> {
  if (!updateCheckEnabled(deps?.env)) return getUpdateState(deps);
  const s = state();
  if (s.inflight) return s.inflight;
  const prev = (s.cache ??= loadPersisted());
  s.inflight = (async () => {
    try {
      const next = await fetchOnce(deps, prev);
      s.cache = next;
      setSetting("update_state", JSON.stringify(next));
      // checkedAt moves on every check, so it is not part of the comparison:
      // the event says "something a client renders changed", and a clean
      // re-check of the same release changes nothing a client renders.
      if (next.latest?.version !== prev.latest?.version || next.error !== prev.error) {
        publishGlobal("", { type: "updates_changed" });
      }
      return compose(next, deps);
    } finally {
      s.inflight = null;
    }
  })();
  return s.inflight;
}

/**
 * Start the six-hourly check, on the same boot self-ping as the other server
 * tickers. Guarded like the scheduler: HMR and a second self-ping both land
 * here, and only the first one gets a timer.
 */
export function startUpdateChecker(): void {
  if (!updateCheckEnabled()) return;
  const s = state();
  if (s.timer) return;
  // Not at boot: the first page load has the persisted state already, and the
  // process has better things to do while it is starting.
  s.first = setTimeout(() => {
    void runUpdateCheck();
  }, FIRST_CHECK_DELAY_MS);
  s.first.unref?.();
  s.timer = setInterval(() => {
    void runUpdateCheck();
  }, CHECK_INTERVAL_MS);
  // Never hold the process open on the ticker alone (same rule as the scheduler).
  s.timer.unref?.();
}
