// Document collaboration mode: a markdown file in the diff opens as a document,
// a selected passage takes a comment, the source can be edited, and Send turns
// both into ONE message — the edit as a patch OR written straight into the
// worktree with the diff as context, the comment with its located line — that
// lands in the transcript through the ordinary chat path. The second entry
// point is the transcript's own Write card, keyed on the path the agent wrote
// rather than on git status, which is what makes a GITIGNORED file reachable:
// the diff never lists it, the card still offers it.
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, getTask, git, gotoApp, makeFixtureRepo, sendMessage, uid, waitForIdle } from "./helpers";

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
let worktreePath: string;
let docPath: string;

// ONE file's diff section, found by the section header rather than by any
// text in the section: once the review is sent, the notes file the mock agent
// writes quotes the packet — "Document review of `docs/setup.md`" — so a
// body-text match would resolve to two sections.
const fileSection = (page: Page, file: string) =>
  page.locator(".tc-file", { has: page.locator(".tc-fhead-main", { hasText: file }) });
const collaborateOn = (page: Page, file: string) => fileSection(page, file).getByRole("button", { name: "Collaborate" });

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
  worktreePath = settled.worktree_path;
  // The document under review, dropped into the worktree the turn cut so the
  // diff lists it (untracked → "?"), exactly as an agent's Write would.
  docPath = path.join(worktreePath, "docs", "setup.md");
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, DOC);
});

test("the file route serves worktree files and refuses everything else", async ({ request }) => {
  const ok = await request.get(`/api/tasks/${taskId}/file?path=docs/setup.md`);
  expect(ok.status()).toBe(200);
  const okJson = await ok.json();
  expect(okJson.content).toBe(DOC);
  // sha is the file's git blob id (lib/worktreeFile.ts blobSha), the anchor a
  // document comment is stamped with — not a real git object here (the file
  // is untracked), just the hash git would compute for these bytes.
  expect(okJson.sha).toMatch(/^[0-9a-f]{40}$/);
  expect((await request.get(`/api/tasks/${taskId}/file?path=../outside.md`)).status()).toBe(400);
  expect((await request.get(`/api/tasks/${taskId}/file?path=docs/missing.md`)).status()).toBe(404);
});

test("edit + comment + send as a patch arrive as one located packet", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(PROJECT, { exact: true }).first().click();
  await page.getByText("Write the setup guide").first().click();

  // Every text file in the diff offers collaboration, so scope to the
  // document's own section.
  await collaborateOn(page, "docs/setup.md").click();
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

  // Passage comments are persisted the moment they're added (task_doc_comments),
  // unlike the edit and the general note, which stay modal-local. Closing here
  // — nothing else dirty yet — fires no confirm dialog, and reopening still
  // shows the comment: it survived the modal unmounting, not just a re-render.
  await modal.locator(".modal-f").getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toBeHidden();
  await collaborateOn(page, "docs/setup.md").click();
  await expect(modal.locator(".collab-c")).toHaveCount(1);

  await modal.getByPlaceholder("Feedback on the document as a whole…").fill("Too terse overall.");

  // Edit: append a line in the source editor; the render beside it follows.
  await modal.locator(".collab-tabs").getByRole("button", { name: "EDIT" }).click();
  await modal.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nRestart the server after changing either value.\n");
  await expect(modal.locator(".collab-render")).toContainText("Restart the server after changing either value.");
  await expect(modal.locator(".collab-status")).toHaveText("edited · 1 comment · general note");
  // The picker appears once there's an edit to route; this test takes the
  // patch route, so the agent's session stays the worktree's only writer.
  await modal.locator(".collab-mode select").selectOption("patch");
  await expect(modal.locator(".collab-hint")).toContainText("sent as a patch");

  await modal.getByRole("button", { name: "Send to agent" }).click();
  await expect(modal).toBeHidden();
  // Patch mode never touches the worktree itself.
  expect(fs.readFileSync(docPath, "utf8")).toBe(DOC);

  const sent = page.locator(".msg", { hasText: "Document review of" }).first();
  await expect(sent).toBeVisible({ timeout: 15_000 });
  await expect(sent).toContainText("--- a/docs/setup.md");
  await expect(sent).toContainText("+Restart the server after changing either value.");
  await expect(sent).toContainText('line 7, under "Configuration":');
  await expect(sent).toContainText("Set PORT to the port you want");
  await expect(sent).toContainText("Say what the default port is.");
  await expect(sent).toContainText("Too terse overall.");
  await expect(sent).toContainText("Apply this patch to the file exactly as written");
  // The mock ran the message as a turn like any other.
  await expect(page.getByText("Mock turn complete").nth(1)).toBeVisible({ timeout: 20_000 });

  // Reopening now shows the comment under "Sent to agent": read-only (no ×),
  // tagged, and — since the underlying file hasn't changed since — not
  // outdated. Nothing to send, so Send to agent is disabled.
  await collaborateOn(page, "docs/setup.md").click();
  await expect(modal.locator(".collab-c.sent")).toHaveCount(1);
  await expect(modal.locator(".collab-c-x")).toHaveCount(0);
  await expect(modal.locator(".collab-c-tag")).toContainText("sent");
  await expect(modal.getByRole("button", { name: "Send to agent" })).toBeDisabled();
  await modal.locator(".modal-f").getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toBeHidden();
});

test("a sent comment goes outdated when the document changes", async ({ page }) => {
  // Change the reviewed file on disk, out from under the sent comment's
  // anchor (the file's blob sha as it was when the comment was written).
  fs.appendFileSync(docPath, "\nChanged after review.\n");

  await gotoApp(page);
  await page.getByText(PROJECT, { exact: true }).first().click();
  await page.getByText("Write the setup guide").first().click();
  await collaborateOn(page, "docs/setup.md").click();
  const modal = page.locator(".modal", { hasText: "Collaborate on document" });

  await expect(modal.locator(".collab-c.sent")).toHaveCount(0);
  const outdatedToggle = modal.locator(".collab-outdated");
  await expect(outdatedToggle).toHaveText(/Show 1 outdated comment/);
  await outdatedToggle.getByRole("button").click();
  await expect(modal.locator(".collab-c.outdated")).toHaveCount(1);
});

test("Write to file lands the edit in the worktree and tells the agent what changed", async ({ page, request }) => {
  // The previous test's turn must be over: a live turn greys the direct
  // option out, and the server would refuse the write anyway.
  await waitForIdle(request, taskId);
  await gotoApp(page);
  await page.getByText(PROJECT, { exact: true }).first().click();
  await page.getByText("Write the setup guide").first().click();
  await collaborateOn(page, "docs/setup.md").click();
  const modal = page.locator(".modal", { hasText: "Collaborate on document" });
  await expect(modal.locator(".collab-render h1")).toHaveText("Setup guide");

  // The previous test changed the file on disk; the edit lands on top of that.
  const before = fs.readFileSync(docPath, "utf8");
  await modal.locator(".collab-tabs").getByRole("button", { name: "EDIT" }).click();
  await modal.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nThe default port is 3000.\n");
  // Only the modal-local halves count: the one saved comment is sent (and
  // outdated), so it's neither a draft nor in the status.
  await expect(modal.locator(".collab-status")).toHaveText("edited");
  // Direct write is the default (a fresh browser context holds no preference).
  const picker = modal.locator(".collab-mode select");
  await expect(picker).toHaveValue("direct");
  await expect(picker.locator("option[value=direct]")).toBeEnabled();
  await expect(modal.locator(".collab-hint")).toContainText("written to the file as-is");

  await modal.getByRole("button", { name: "Send to agent" }).click();
  await expect(modal).toBeHidden();
  // The file on disk carries the edit before the agent has done anything.
  expect(fs.readFileSync(docPath, "utf8")).toBe(before + "\nThe default port is 3000.\n");

  const sent = page.locator(".msg", { hasText: "directly in the worktree — the file on disk already has these changes" }).first();
  await expect(sent).toBeVisible({ timeout: 15_000 });
  await expect(sent).toContainText("do NOT apply this diff again");
  await expect(sent).toContainText("+The default port is 3000.");
  await expect(sent).not.toContainText("Apply this patch");
  await expect(page.getByText("Mock turn complete").nth(2)).toBeVisible({ timeout: 20_000 });
  // The Changes tab refetched: the diff shows the user's line, not just the agent's.
  await expect(fileSection(page, "docs/setup.md")).toContainText("The default port is 3000.");
});

test("the write route refuses a live turn and a stale original", async ({ request }) => {
  await waitForIdle(request, taskId);
  const current = fs.readFileSync(docPath, "utf8");
  const write = (original: string, content: string) =>
    request.post(`/api/tasks/${taskId}/file`, { data: { path: "docs/setup.md", original, content } });

  // Hold a turn open; the write is refused for as long as it lasts.
  await sendMessage(request, taskId, "e2e:sleep=4000");
  expect((await getTask(request, taskId)).running).toBe(1);
  const busy = await write(current, current + "\nClobber.\n");
  expect(busy.status()).toBe(409);
  expect((await busy.json()).error).toMatch(/turn is running/);
  expect(fs.readFileSync(docPath, "utf8")).toBe(current);
  await waitForIdle(request, taskId);

  // A modal that loaded an older text can't write over what's there now —
  // the refusal carries the current text.
  const stale = await write(DOC, DOC + "\nMy edit.\n");
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toEqual({ error: "file changed since it was loaded", current });
  expect(fs.readFileSync(docPath, "utf8")).toBe(current);

  // Same guard as the read: nothing outside the worktree, nothing new.
  expect((await request.post(`/api/tasks/${taskId}/file`, { data: { path: "../outside.md", original: "x", content: "y" } })).status()).toBe(400);
  expect((await request.post(`/api/tasks/${taskId}/file`, { data: { path: "docs/new.md", original: "", content: "y" } })).status()).toBe(404);

  const ok = await write(current, current + "Appended over the API.\n");
  expect(ok.status()).toBe(200);
  expect(fs.readFileSync(docPath, "utf8")).toBe(current + "Appended over the API.\n");
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
