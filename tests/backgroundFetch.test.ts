import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { backgroundFetchProject, sweepBackgroundFetch, resetBackgroundFetchState } from "../lib/backgroundFetch";
import { buildDivergencePrompt } from "../lib/baseDivergence";
import { BACKGROUND_FETCH_INTERVAL_MS } from "../lib/config";
import { createProject, updateProject, getSetting, setSetting } from "../lib/store";
import { git, uid, commitFile, makeRepoWithOrigin, pushFromColleague } from "./helpers";

// Every case builds a bare origin, a colleague clone and a project clone before it asserts anything.
vi.setConfig({ testTimeout: 120_000 });

describe("backgroundFetchProject", () => {
  it("fast-forwards a clean checkout that is behind origin", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    const remoteSha = await pushFromColleague(colleague, "remote.txt", "landed on origin\n");
    const project = createProject({ name: `bf-ok-${uid()}`, repo_path: repo, branch: "main" });

    const res = await backgroundFetchProject(project);

    expect(res).toEqual({ project: project.id, fetched: true, advanced: true });
    expect(await git(repo, "rev-parse", "main")).toBe(remoteSha);
  });

  it("leaves the branch alone when the checkout has uncommitted changes", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await pushFromColleague(colleague, "remote.txt", "landed on origin\n");
    fs.writeFileSync(path.join(repo, "file.txt"), "edited but not committed\n");
    const before = await git(repo, "rev-parse", "main");
    const project = createProject({ name: `bf-dirty-${uid()}`, repo_path: repo, branch: "main" });

    const res = await backgroundFetchProject(project);

    expect(res.fetched).toBe(true);
    if (res.fetched) {
      expect(res.advanced).toBe(false);
      expect(res.reason).toContain("uncommitted");
    }
    expect(await git(repo, "rev-parse", "main")).toBe(before);
  });

  it("fetches but does not move a diverged branch", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await pushFromColleague(colleague, "remote.txt", "landed on origin\n");
    const localSha = await commitFile(repo, "local.txt", "not pushed yet\n", "local only");
    const project = createProject({ name: `bf-div-${uid()}`, repo_path: repo, branch: "main" });

    const res = await backgroundFetchProject(project);

    expect(res).toMatchObject({ fetched: true, advanced: false });
    expect(await git(repo, "rev-parse", "main")).toBe(localSha);
  });
});

describe("sweepBackgroundFetch", () => {
  beforeEach(() => resetBackgroundFetchState());

  it("fetches only opted-in projects, honors the interval, and runs again after a reset", async () => {
    const on = await makeRepoWithOrigin();
    const off = await makeRepoWithOrigin();
    await pushFromColleague(on.colleague, "remote.txt", "landed on origin\n");
    await pushFromColleague(off.colleague, "remote.txt", "landed on origin\n");
    const offBefore = await git(off.repo, "rev-parse", "main");
    const enabled = createProject({ name: `bf-on-${uid()}`, repo_path: on.repo, branch: "main" });
    const disabled = createProject({ name: `bf-off-${uid()}`, repo_path: off.repo, branch: "main" });
    updateProject(enabled.id, { background_fetch: 1 });
    updateProject(disabled.id, { background_fetch: 0 });

    const now = 10 * BACKGROUND_FETCH_INTERVAL_MS;
    const first = await sweepBackgroundFetch(now);
    expect(first.map((o) => o.project)).toContain(enabled.id);
    expect(first.map((o) => o.project)).not.toContain(disabled.id);
    expect(await git(off.repo, "rev-parse", "main")).toBe(offBefore);

    const second = await sweepBackgroundFetch(now + 1000);
    expect(second.map((o) => o.project)).not.toContain(enabled.id);

    const third = await sweepBackgroundFetch(now + BACKGROUND_FETCH_INTERVAL_MS);
    expect(third.map((o) => o.project)).toContain(enabled.id);

    resetBackgroundFetchState();
    const fourth = await sweepBackgroundFetch(now + 1000);
    expect(fourth.map((o) => o.project)).toContain(enabled.id);
  });

  it("does nothing while background jobs are off", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await pushFromColleague(colleague, "remote.txt", "landed on origin\n");
    const project = createProject({ name: `bf-jobs-${uid()}`, repo_path: repo, branch: "main" });
    updateProject(project.id, { background_fetch: 1 });
    const prior = getSetting("background_jobs");
    setSetting("background_jobs", "off");
    try {
      expect(await sweepBackgroundFetch(10 * BACKGROUND_FETCH_INTERVAL_MS)).toEqual([]);
    } finally {
      setSetting("background_jobs", prior ?? "on");
    }
  });
});

describe("buildDivergencePrompt", () => {
  const facts = { label: "origin/main", ahead: 1, behind: 2, localTip: "aaa111", remoteTip: "bbb222" };

  it("names the checkout, both tips and the label, and forbids force-pushing", () => {
    const prompt = buildDivergencePrompt({ repo_path: "/work/repo", branch: "main", landing_mode: "merge" }, facts);

    expect(prompt).toContain("/work/repo");
    expect(prompt).toContain("aaa111");
    expect(prompt).toContain("bbb222");
    expect(prompt).toContain("origin/main");
    expect(prompt).toContain("Never force-push main");
  });

  it("points a pr-mode project at create_pr", () => {
    const prompt = buildDivergencePrompt({ repo_path: "/work/repo", branch: "main", landing_mode: "pr" }, facts);

    expect(prompt).toContain("only takes pull requests");
    expect(prompt).toContain("create_pr");
  });
});
