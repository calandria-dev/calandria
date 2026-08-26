// Shared helpers for the e2e specs. API-level setup (projects, tasks, turns)
// goes through the same REST routes the UI uses — helpers exist so a spec that
// is ABOUT merging doesn't have to click through onboarding + project + task
// creation first; those flows get their own UI-driven specs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { FIXTURES_DIR, GIT_ENV } from "./env";

/**
 * Open the app with the optional first-run nudges pre-dismissed (the "Add
 * another agent" and welcome-coach modals scrim the whole UI and would
 * intercept every click). Onboarding itself is NOT bypassed here — 01-onboarding
 * covers the wizard; everything else calls ensureOnboarded() in beforeAll.
 */
export async function gotoApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("calandria_agent_nudge_dismissed", "1");
    localStorage.setItem("calandria:welcomeCoach:dismissed", "1");
  });
  await page.goto("/");
}

let seq = 0;
export function uid(): string {
  return `${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A committed git repo (main branch, one README) for a project to point at. */
export function makeFixtureRepo(name: string): string {
  const dir = path.join(FIXTURES_DIR, `${name}-${uid()}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}

/**
 * Make sure the instance is past first-run: mock agent verified (persists the
 * connection record) and onboarding marked complete (adopts mock as the app's
 * default agent). Idempotent — lets every spec after 01-onboarding run standalone.
 */
export async function ensureOnboarded(request: APIRequestContext): Promise<void> {
  const verify = await request.post("/api/agents/mock/verify");
  expect(verify.ok()).toBeTruthy();
  const done = await request.post("/api/onboarding");
  expect(done.ok()).toBeTruthy();
}

export async function createProject(
  request: APIRequestContext,
  opts: { name: string; repoPath: string; branch?: string }
): Promise<{ id: string; name: string; repo_path: string; branch: string }> {
  const res = await request.post("/api/projects", {
    data: { name: opts.name, sub: "e2e", context: "E2E fixture project.", repo_path: opts.repoPath, branch: opts.branch ?? "main" },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

// `suggested` files the row straight into the tray the way an agent's
// suggest_task does — the tray's own behaviors don't need a turn to run first.
export async function createTask(
  request: APIRequestContext,
  opts: { projectId: string; title: string; description?: string; suggested?: boolean }
): Promise<{ id: string; title: string }> {
  const res = await request.post("/api/tasks", {
    data: { project_id: opts.projectId, title: opts.title, description: opts.description ?? "", priority: "med", agent: "mock", ...(opts.suggested ? { suggested: true } : {}) },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

/** Kick off a turn. Initial starts use the generic opener; later turns use `text`. */
export async function sendMessage(request: APIRequestContext, taskId: string, text = "go"): Promise<void> {
  const res = await request.post(`/api/tasks/${taskId}/messages`, { data: { text } });
  expect(res.ok()).toBeTruthy();
}

export async function getTask(request: APIRequestContext, taskId: string): Promise<any> {
  const res = await request.get(`/api/tasks/${taskId}`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Wait until the task has started and no turn is live (the runner settled the row). */
export async function waitForIdle(request: APIRequestContext, taskId: string, timeout = 30_000): Promise<any> {
  await expect
    .poll(async () => {
      const t = await getTask(request, taskId);
      return t.started === 1 && t.running === 0;
    }, { timeout, message: `task ${taskId} never settled` })
    .toBeTruthy();
  return getTask(request, taskId);
}

/** Create project + task and run the initial turn to completion. */
export async function runTaskToCompletion(
  request: APIRequestContext,
  opts: { name: string; title: string; description?: string }
): Promise<{ project: any; task: any; repoPath: string }> {
  const repoPath = makeFixtureRepo(opts.name);
  const project = await createProject(request, { name: opts.name, repoPath });
  const task = await createTask(request, { projectId: project.id, title: opts.title, description: opts.description });
  await sendMessage(request, task.id);
  const settled = await waitForIdle(request, task.id);
  return { project, task: settled, repoPath };
}
