// Document collaboration mode: a markdown file in the diff opens as a document,
// a selected passage takes a comment, the source can be edited, and Send turns
// both into ONE message — the edit as a patch, the comment with its located
// line — that lands in the transcript through the ordinary chat path. The
// second entry point is the transcript's own Write card, keyed on the path the
// agent wrote rather than on git status, which is what makes a GITIGNORED file
// reachable: the diff never lists it, the card still offers it.
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, git, gotoApp, makeFixtureRepo, sendMessage, uid, waitForIdle } from "./helpers";

const PROJECT = `Collab Doc ${uid()}`;
const DOC = [
  "# Setup guide",
  "",
  "Install the **CLI** first, then run `calandria init`.",
  "",
  "## Configuration",
  "",
  "- Set `PORT` to the port you want",
  "- Set `BASE_URL` when behind a proxy",
  "",
  "The server reads both at boot and never re-reads them while running.",
  "",
].join("\n");

let taskId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  // `scratch/` is gitignored in the fixture, so what the mock writes there is
  // invisible to `git ls-files --others --exclude-standard` — the diff's
  // untracked list — while CHANGELOG.md gives the branch a real commit.
  const repo = makeFixtureRepo("collab-doc");
  fs.writeFileSync(path.join(repo, ".gitignore"), "scratch/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "ignore scratch");
  const project = await createProject(request, { name: PROJECT, repoPath: repo });
  // Directives live in the description: the opening turn's user text is the
  // fixed INITIAL_TASK_PROMPT, and the mock reads the task metadata instead.
  const task = await createTask(request, {
    projectId: project.id,
    title: "Write the setup guide",
    description: ["e2e:write=CHANGELOG.md:- setup guide", "e2e:write=scratch/notes.md:# Scratch notes"].join("\n"),
  });
  await sendMessage(request, task.id);
  const settled = await waitForIdle(request, task.id);
  taskId = task.id;
  // The document under review, dropped into the worktree the turn cut so the
  // diff lists it (untracked → "?"), exactly as an agent's Write would.
  const abs = path.join(settled.worktree_path, "docs", "setup.md");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, DOC);
});

test("the file route serves worktree files and refuses everything else", async ({ request }) => {
  const ok = await request.get(`/api/tasks/${taskId}/file?path=docs/setup.md`);
  expect(ok.status()).toBe(200);
  expect((await ok.json()).content).toBe(DOC);
  expect((await request.get(`/api/tasks/${taskId}/file?path=../outside.md`)).status()).toBe(400);
  expect((await request.get(`/api/tasks/${taskId}/file?path=docs/missing.md`)).status()).toBe(404);
});

test("edit + comment + send arrive as one located packet", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(PROJECT, { exact: true }).first().click();
  await page.getByText("Write the setup guide").first().click();

  // Every text file in the diff offers collaboration, so scope to the
  // document's own section.
  await page.locator(".tc-file", { hasText: "docs/setup.md" }).getByRole("button", { name: "Collaborate" }).click();
  const modal = page.locator(".modal", { hasText: "Collaborate on document" });
  await expect(modal.locator(".collab-render h1")).toHaveText("Setup guide");

  // Comment: select the first list item, attach a note.
  await page.evaluate(() => {
    const root = document.querySelector(".collab-selectable")!;
    const range = document.createRange();
    range.selectNodeContents(root.querySelectorAll("li")[0]);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await modal.getByRole("button", { name: "Add comment" }).click();
  await modal.getByPlaceholder("What should change here?").fill("Say what the default port is.");
  await modal.getByRole("button", { name: "Add", exact: true }).click();
  await expect(modal.locator(".collab-c")).toHaveCount(1);
  await expect(modal.locator(".collab-c-where")).toHaveText("Configuration");
  await modal.getByPlaceholder("Feedback on the document as a whole…").fill("Too terse overall.");

  // Edit: append a line in the source editor; the render beside it follows.
  await modal.locator(".collab-tabs").getByRole("button", { name: "EDIT" }).click();
  await modal.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nRestart the server after changing either value.\n");
  await expect(modal.locator(".collab-render")).toContainText("Restart the server after changing either value.");
  await expect(modal.locator(".collab-status")).toHaveText("edited · 1 comment · general note");

  await modal.getByRole("button", { name: "Send to agent" }).click();
  await expect(modal).toBeHidden();

  const sent = page.locator(".msg", { hasText: "Document review of" }).first();
  await expect(sent).toBeVisible({ timeout: 15_000 });
  await expect(sent).toContainText("--- a/docs/setup.md");
  await expect(sent).toContainText("+Restart the server after changing either value.");
  await expect(sent).toContainText('line 7, under "Configuration":');
  await expect(sent).toContainText("Set PORT to the port you want");
  await expect(sent).toContainText("Say what the default port is.");
  await expect(sent).toContainText("Too terse overall.");
  // The mock ran the message as a turn like any other.
  await expect(page.getByText("Mock turn complete").nth(1)).toBeVisible({ timeout: 20_000 });
});

test("a gitignored file the agent wrote opens from its transcript card, though the diff never lists it", async ({ page, request }) => {
  // The route's only screen is "inside the worktree" — git status is not
  // consulted, so the ignored file is served like any other.
  const served = await request.get(`/api/tasks/${taskId}/file?path=scratch/notes.md`);
  expect(served.status()).toBe(200);
  expect((await served.json()).content).toBe("# Scratch notes\n");
  // …and the diff, which follows git, doesn't know it exists.
  const diff = await request.get(`/api/tasks/${taskId}/diff`);
  const listed = ((await diff.json()).files as { path: string }[]).map((f) => f.path);
  expect(listed).toContain("CHANGELOG.md");
  expect(listed).not.toContain("scratch/notes.md");

  await gotoApp(page);
  await page.getByText(PROJECT, { exact: true }).first().click();
  await page.getByText("Write the setup guide").first().click();
  await expect(page.locator(".tc-file", { hasText: "CHANGELOG.md" })).toBeVisible();
  await expect(page.locator(".tc-file", { hasText: "scratch/notes.md" })).toHaveCount(0);

  const card = page.locator(".tool", { hasText: "Write notes.md" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Collaborate" }).click();
  const modal = page.locator(".modal", { hasText: "Collaborate on document" });
  await expect(modal.locator(".m-sub")).toHaveText("scratch/notes.md");
  await expect(modal.locator(".collab-render h1")).toHaveText("Scratch notes");
  await modal.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toBeHidden();
});
