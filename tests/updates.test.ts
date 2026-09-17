/**
 * The update check: version comparison, install-method detection, release-note
 * trimming, the checker itself, its two routes, and the pure client model that
 * turns the state into the blocks the popover renders.
 *
 * No test here reaches github.com. The checker takes an injected `fetch`, and
 * the routes run with CALANDRIA_UPDATE_FEED_URL pointed at a value the
 * injected fetch recognises.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compareVersions, isNewer, parseVersion } from "@/lib/updates/semver";
import { detectInstallMethod } from "@/lib/updates/installMethod";
import { trimReleaseNotes } from "@/lib/updates/notes";
import { getUpdateState, resetUpdateCache, runUpdateCheck, updateCheckEnabled } from "@/lib/updates/check";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { getSetting, setSetting } from "@/lib/store";
import { GET as getUpdates } from "@/app/api/updates/route";
import { POST as postUpdateCheck } from "@/app/api/updates/check/route";
import { PATCH as patchSettings } from "@/app/api/settings/route";
import { updateTargets } from "@/app/shell/updateTargets";
import type { DesktopUpdateDetail, UpdateState } from "@/lib/updates/types";

describe("semver", () => {
  it("orders by each component in turn", () => {
    expect(isNewer("0.12.0", "0.11.0")).toBe(true);
    expect(isNewer("0.11.10", "0.11.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.11.0", "0.12.0")).toBe(false);
  });

  it("does not call an equal version newer", () => {
    expect(isNewer("0.11.0", "0.11.0")).toBe(false);
    expect(compareVersions("0.11.0", "0.11.0")).toBe(0);
  });

  it("strips a leading v, which is how the tags are spelled", () => {
    expect(parseVersion("v0.12.0")).toEqual({ major: 0, minor: 12, patch: 0 });
    expect(isNewer("v0.12.0", "0.11.0")).toBe(true);
  });

  it("treats anything it cannot parse as older than every real version", () => {
    for (const bad of ["abc", "0.12", "", null, undefined]) {
      expect(parseVersion(bad)).toBeNull();
      expect(isNewer(bad, "0.11.0")).toBe(false);
      expect(compareVersions(bad, "0.11.0")).toBe(-1);
    }
    // Two unparseable strings are equal, so neither produces a pill.
    expect(compareVersions("abc", "0.12")).toBe(0);
  });
});

describe("installMethod", () => {
  const none = () => false;

  it("reads the env var the Dockerfile sets", () => {
    expect(detectInstallMethod({ env: { CALANDRIA_CONTAINER: "1" }, exists: none, root: "/app" })).toBe("container");
  });

  it("falls back to /.dockerenv for an image that did not set it", () => {
    expect(detectInstallMethod({ env: {}, exists: (p) => p === "/.dockerenv", root: "/app" })).toBe("container");
  });

  it("calls a checkout with a .git entry a source install", () => {
    expect(detectInstallMethod({ env: {}, exists: (p) => p === "/repo/.git", root: "/repo" })).toBe("source");
  });

  it("prefers container when both signals are present", () => {
    expect(
      detectInstallMethod({ env: { CALANDRIA_CONTAINER: "1" }, exists: (p) => p === "/repo/.git", root: "/repo" }),
    ).toBe("container");
  });

  it("calls everything else bundled", () => {
    expect(detectInstallMethod({ env: {}, exists: none, root: "/payload" })).toBe("bundled");
  });
});

describe("release notes", () => {
  const BODY = [
    "## [0.12.0](https://github.com/calandria-dev/calandria/compare/v0.11.0...v0.12.0) (2026-09-15)",
    "",
    "### Features",
    "",
    "* **updates:** titlebar pill ([abc1234](https://example/abc1234))",
    "",
    "<!-- desktop-artifacts -->",
    "",
    "| Installer | Signed |",
    "|-|-|",
    "| macOS | yes |",
  ].join("\n");

  it("cuts at the artifacts marker", () => {
    const out = trimReleaseNotes(BODY);
    expect(out).not.toContain("desktop-artifacts");
    expect(out).not.toContain("Installer");
  });

  it("drops the version heading, so the popover header is not repeated", () => {
    expect(trimReleaseNotes(BODY).split("\n")[0]).toBe("### Features");
  });

  it("returns a body with no marker whole", () => {
    expect(trimReleaseNotes("### Bug Fixes\n\n* something")).toBe("### Bug Fixes\n\n* something");
  });

  it("trims the blank lines the cut leaves behind", () => {
    const out = trimReleaseNotes(BODY);
    expect(out.startsWith("\n")).toBe(false);
    expect(out.endsWith("\n")).toBe(false);
  });

  it("survives an empty body", () => {
    expect(trimReleaseNotes("")).toBe("");
    expect(trimReleaseNotes(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The checker.
// ---------------------------------------------------------------------------

const FEED = "https://feed.test/releases";

function body(version: string) {
  return [
    `## [${version}](https://github.com/calandria-dev/calandria/compare/v0.0.0...v${version}) (2026-09-15)`,
    "",
    "### Features",
    "",
    `* **updates:** something in ${version} ([abc1234](https://example/abc1234))`,
    "",
    "<!-- desktop-artifacts -->",
    "",
    "| Installer | Signed |",
    "|-|-|",
  ].join("\n");
}

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    body: body(tag.replace(/^v/, "")),
    draft: false,
    prerelease: false,
    html_url: `https://github.com/calandria-dev/calandria/releases/tag/${tag}`,
    published_at: "2026-09-15T10:02:11Z",
    ...extra,
  };
}

const FIXTURE = [
  release("v0.12.0"),
  release("v0.11.1"),
  release("v0.13.0", { draft: true }),
  release("v0.12.1-rc.1", { prerelease: true }),
];

/** A fetch that answers the fixture and records what it was asked. */
function feedFetch(payload: unknown = FIXTURE, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  });
  return { fn: fn as unknown as typeof fetch, calls, mock: fn };
}

const ENV = { CALANDRIA_UPDATE_FEED_URL: FEED };

/** Everything the checker writes lives in three settings rows. */
function clearUpdateSettings() {
  for (const k of ["update_state", "update_check", "update_dismissed"]) setSetting(k, null);
  resetUpdateCache();
}

/** Collect every global bus event published while `fn` runs. */
async function published<T>(fn: () => Promise<T>): Promise<{ result: T; events: BusEvent[] }> {
  const events: BusEvent[] = [];
  const unsub = subscribeGlobal((_taskId, ev) => events.push(ev));
  try {
    return { result: await fn(), events };
  } finally {
    unsub();
  }
}

describe("checker", () => {
  beforeEach(clearUpdateSettings);
  afterEach(clearUpdateSettings);

  it("keeps the published stable releases and drops the rest", async () => {
    const f = feedFetch();
    const state = await runUpdateCheck({ fetch: f.fn, env: ENV, currentVersion: "0.11.0" });
    expect(state.latest?.version).toBe("0.12.0");
    expect(state.latest?.tag).toBe("v0.12.0");
    expect(state.releases.map((r) => r.version)).toEqual(["0.12.0", "0.11.1"]);
    expect(state.available).toBe(true);
    expect(state.checkedAt).toBeTruthy();
    expect(state.error).toBeNull();
    // The notes are trimmed on the way in, so the client never sees the table.
    expect(state.releases[0].notes.startsWith("### Features")).toBe(true);
    expect(state.releases[0].notes).not.toContain("Installer");
  });

  it("reports nothing to do when the running version is the newest one", async () => {
    const f = feedFetch();
    const state = await runUpdateCheck({ fetch: f.fn, env: ENV, currentVersion: "0.12.0" });
    expect(state.available).toBe(false);
    expect(state.releases).toEqual([]);
    expect(state.latest?.version).toBe("0.12.0");
  });

  it("keeps the last good answer when the request throws", async () => {
    await runUpdateCheck({ fetch: feedFetch().fn, env: ENV, currentVersion: "0.11.0" });
    const boom = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    });
    const state = await runUpdateCheck({
      fetch: boom as unknown as typeof fetch,
      env: ENV,
      currentVersion: "0.11.0",
    });
    expect(state.latest?.version).toBe("0.12.0");
    expect(state.available).toBe(true);
    expect(state.error).toBe("getaddrinfo ENOTFOUND api.github.com");
    expect(state.checkedAt).toBeTruthy();
  });

  it("names the status code when GitHub refuses", async () => {
    const state = await runUpdateCheck({
      fetch: feedFetch({ message: "rate limited" }, 403).fn,
      env: ENV,
      currentVersion: "0.11.0",
    });
    expect(state.error).toBe("GitHub returned 403");
  });

  it("asks nothing when the operator turned the check off", async () => {
    const f = feedFetch();
    const state = await runUpdateCheck({
      fetch: f.fn,
      env: { ...ENV, CALANDRIA_UPDATE_CHECK: "off" },
      currentVersion: "0.11.0",
    });
    expect(state.enabled).toBe(false);
    expect(f.mock).not.toHaveBeenCalled();
    expect(updateCheckEnabled({ CALANDRIA_UPDATE_CHECK: "off" })).toBe(false);
  });

  it("asks nothing when the switch in Settings is off", async () => {
    setSetting("update_check", "off");
    const f = feedFetch();
    const state = await runUpdateCheck({ fetch: f.fn, env: ENV, currentVersion: "0.11.0" });
    expect(state.enabled).toBe(false);
    expect(f.mock).not.toHaveBeenCalled();
  });

  it("shares one request between two callers", async () => {
    const f = feedFetch();
    const [a, b] = await Promise.all([
      runUpdateCheck({ fetch: f.fn, env: ENV, currentVersion: "0.11.0" }),
      runUpdateCheck({ fetch: f.fn, env: ENV, currentVersion: "0.11.0" }),
    ]);
    expect(f.mock).toHaveBeenCalledTimes(1);
    expect(a.latest?.version).toBe("0.12.0");
    expect(b.latest?.version).toBe("0.12.0");
  });

  it("persists the result and announces it once", async () => {
    const first = await published(() => runUpdateCheck({ fetch: feedFetch().fn, env: ENV, currentVersion: "0.11.0" }));
    expect(first.events.filter((e) => e.type === "updates_changed")).toHaveLength(1);
    expect(JSON.parse(getSetting("update_state") || "{}").latest.version).toBe("0.12.0");

    // Same answer, so nothing a client renders moved.
    const second = await published(() => runUpdateCheck({ fetch: feedFetch().fn, env: ENV, currentVersion: "0.11.0" }));
    expect(second.events.filter((e) => e.type === "updates_changed")).toHaveLength(0);
  });

  it("serves the persisted result on a fresh process without asking again", async () => {
    await runUpdateCheck({ fetch: feedFetch().fn, env: ENV, currentVersion: "0.11.0" });
    resetUpdateCache();
    const state = getUpdateState({ currentVersion: "0.11.0" });
    expect(state.latest?.version).toBe("0.12.0");
    expect(state.releases.map((r) => r.version)).toEqual(["0.12.0", "0.11.1"]);
    expect(state.available).toBe(true);
  });

  it("names itself and asks the configured feed", async () => {
    const f = feedFetch();
    await runUpdateCheck({ fetch: f.fn, env: ENV, currentVersion: "0.11.0" });
    expect(f.calls[0].url).toBe(FEED);
    const headers = f.calls[0].init?.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe("calandria/0.11.0");
  });

  it("reports the version somebody skipped, read at call time", async () => {
    await runUpdateCheck({ fetch: feedFetch().fn, env: ENV, currentVersion: "0.11.0" });
    expect(getUpdateState({ currentVersion: "0.11.0" }).dismissedVersion).toBeNull();
    setSetting("update_dismissed", "0.12.0");
    expect(getUpdateState({ currentVersion: "0.11.0" }).dismissedVersion).toBe("0.12.0");
  });
});

// ---------------------------------------------------------------------------
// The routes.
// ---------------------------------------------------------------------------

describe("routes", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    clearUpdateSettings();
    process.env.CALANDRIA_UPDATE_FEED_URL = FEED;
    globalThis.fetch = feedFetch().fn;
  });

  afterEach(() => {
    clearUpdateSettings();
    delete process.env.CALANDRIA_UPDATE_FEED_URL;
    delete process.env.CALANDRIA_UPDATE_CHECK;
    globalThis.fetch = realFetch;
  });

  it("GET /api/updates serves the cached state", async () => {
    await postUpdateCheck();
    setSetting("update_dismissed", "0.12.0");
    const state = await (await getUpdates()).json();
    expect(state.latest.version).toBe("0.12.0");
    expect(state.dismissedVersion).toBe("0.12.0");
    expect(state.current.version).toBeTruthy();
  });

  it("POST /api/updates/check asks now", async () => {
    const res = await postUpdateCheck();
    expect(res.status).toBe(200);
    expect((await res.json()).latest.version).toBe("0.12.0");
  });

  it("POST /api/updates/check answers 200 with the check turned off", async () => {
    process.env.CALANDRIA_UPDATE_CHECK = "off";
    const res = await postUpdateCheck();
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.enabled).toBe(false);
    expect(state.latest).toBeNull();
  });

  it("PATCH /api/settings takes the two update keys and refuses the cache", async () => {
    const req = new Request("http://x/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_check: "off", update_dismissed: "0.12.0", update_state: "{}" }),
    });
    const { events } = await published(async () => patchSettings(req));
    expect(getSetting("update_check")).toBe("off");
    expect(getSetting("update_dismissed")).toBe("0.12.0");
    expect(getSetting("update_state")).toBeNull();
    expect(events.filter((e) => e.type === "updates_changed")).toHaveLength(1);
  });

  it("PATCH /api/settings says nothing when no update key moved", async () => {
    const req = new Request("http://x/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ background_jobs: "off" }),
    });
    const { events } = await published(async () => patchSettings(req));
    expect(events.filter((e) => e.type === "updates_changed")).toHaveLength(0);
    setSetting("background_jobs", null);
  });
});

// ---------------------------------------------------------------------------
// The client model.
// ---------------------------------------------------------------------------

describe("updateTargets", () => {
  const base = (over: Partial<UpdateState> = {}): UpdateState => ({
    enabled: true,
    current: {
      version: "0.11.0",
      sha: "0b10f47",
      builtAt: "2026-09-08T15:40:00Z",
      installMethod: "container",
      instanceName: null,
      ...(over.current || {}),
    },
    latest: { version: "0.12.0", tag: "v0.12.0", url: "https://example/0.12.0", publishedAt: "2026-09-15T10:02:11Z" },
    available: true,
    releases: [],
    dismissedVersion: null,
    checkedAt: "2026-09-15T12:00:00Z",
    error: null,
    ...over,
  });

  const detail = (over: Partial<DesktopUpdateDetail> = {}): DesktopUpdateDetail => ({
    shellVersion: "0.11.0",
    phase: "idle",
    version: null,
    percent: null,
    disposition: { enabled: true, code: "ok", reason: "" },
    error: null,
    ...over,
  });

  const browser = { kind: "browser" as const, version: null };
  const desktopShell = { kind: "desktop" as const, version: "0.11.0" };

  it("offers the compose steps to a browser on a container that is behind", () => {
    const t = updateTargets({ server: base(), desktop: null, shell: browser });
    expect(t).toEqual([
      { kind: "server", from: "0.11.0", to: "0.12.0", method: "container", instanceName: null },
    ]);
  });

  it("offers the git steps to a browser on a source checkout", () => {
    const server = base({ current: { ...base().current, installMethod: "source" } });
    const t = updateTargets({ server, desktop: null, shell: browser });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: "server", method: "source" });
  });

  it("offers nothing when the server is already the newest release", () => {
    const server = base({ current: { ...base().current, version: "0.12.0" }, available: false });
    expect(updateTargets({ server, desktop: null, shell: browser })).toEqual([]);
  });

  it("counts a bundled server inside the desktop app as one target, the shell", () => {
    const server = base({ current: { ...base().current, installMethod: "bundled" } });
    const t = updateTargets({ server, desktop: detail({ phase: "ready", version: "0.12.0" }), shell: desktopShell });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: "shell", from: "0.11.0", to: "0.12.0", phase: "ready" });
  });

  it("names the server alone when the desktop app is current and its instance is not", () => {
    const t = updateTargets({
      server: base(),
      desktop: detail({ shellVersion: "0.12.0" }),
      shell: { kind: "desktop", version: "0.12.0" },
    });
    expect(t.map((x) => x.kind)).toEqual(["server"]);
  });

  it("names the shell alone when the instance is current and the app is not", () => {
    const server = base({ current: { ...base().current, version: "0.12.0" }, available: false });
    const t = updateTargets({ server, desktop: detail(), shell: desktopShell });
    expect(t.map((x) => x.kind)).toEqual(["shell"]);
  });

  it("puts the server first when both are behind", () => {
    const t = updateTargets({ server: base(), desktop: detail(), shell: desktopShell });
    expect(t.map((x) => x.kind)).toEqual(["server", "shell"]);
  });

  it("hides a skipped version, but not a download that already happened", () => {
    const server = base({ dismissedVersion: "0.12.0" });
    expect(updateTargets({ server, desktop: null, shell: browser })).toEqual([]);
    expect(updateTargets({ server, desktop: detail(), shell: desktopShell })).toEqual([]);
    const downloaded = updateTargets({
      server,
      desktop: detail({ phase: "ready", version: "0.12.0" }),
      shell: desktopShell,
    });
    expect(downloaded.map((x) => x.kind)).toEqual(["shell"]);
  });

  it("brings the pill back for a release newer than the skipped one", () => {
    const server = base({
      dismissedVersion: "0.12.0",
      latest: { version: "0.13.0", tag: "v0.13.0", url: "https://example/0.13.0", publishedAt: "2026-10-01T00:00:00Z" },
    });
    expect(updateTargets({ server, desktop: null, shell: browser }).map((x) => x.kind)).toEqual(["server"]);
  });

  it("offers nothing at all when the check is off", () => {
    expect(updateTargets({ server: base({ enabled: false }), desktop: detail(), shell: desktopShell })).toEqual([]);
  });

  it("carries a failed shell update through to the popover", () => {
    const server = base({ current: { ...base().current, installMethod: "bundled" } });
    const t = updateTargets({
      server,
      desktop: detail({ phase: "error", error: "The update check failed." }),
      shell: desktopShell,
    });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: "shell", phase: "error", error: "The update check failed." });
  });

  it("carries the disposition, so a shell that cannot update says why", () => {
    const server = base({ current: { ...base().current, installMethod: "bundled" } });
    const disposition = { enabled: false, code: "linux-package", reason: "Installed from a system package." };
    const t = updateTargets({ server, desktop: detail({ disposition }), shell: desktopShell });
    expect(t[0]).toMatchObject({ kind: "shell", disposition });
  });

  it("offers nothing before the first check has an answer", () => {
    expect(updateTargets({ server: base({ latest: null, available: false }), desktop: null, shell: browser })).toEqual(
      [],
    );
    expect(updateTargets({ server: null, desktop: null, shell: browser })).toEqual([]);
  });
});
