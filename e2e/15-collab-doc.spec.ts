// Document collaboration mode: a markdown file in the diff opens as a document,
// a selected passage takes a comment, the source can be edited, and Send turns
// both into ONE message — the edit as a patch, the comment with its located
// line — that lands in the transcript through the ordinary chat path.
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, sendMessage, uid, waitForIdle } from "./helpers";

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

// The Collaborate button in ONE file's diff section, found by the section
// header rather than by any text in the section: once the review is sent, the
// notes file the mock agent writes quotes the packet — "Document review of
// `docs/setup.md`" — so a body-text match would resolve to two sections.
const collaborateOn = (page: Page, file: string) =>
  page.locator(".tc-file", { has: page.locator(".tc-fhead-main", { hasText: file }) }).getByRole("button", { name: "Collaborate" });

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("collab-doc") });
  const task = await createTask(request, { projectId: project.id, title: "Write the setup guide" });
  await sendMessage(request, task.id);
  const settled = await waitForIdle(request, task.id);
  taskId = task.id;
  worktreePath = settled.worktree_path;
  // The document under review, dropped into the worktree the turn cut so the
  // diff lists it (untracked → "?"), exactly as an agent's Write would.
  const abs = path.join(worktreePath, "docs", "setup.md");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, DOC);
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

test("edit + comment + send arrive as one located packet", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(PROJECT, { exact: true }).first().click();
  await page.getByText("Write the setup guide").first().click();

  // Only the markdown file offers collaboration; the notes file the mock
  // writes is markdown too, so scope to the document's own section.
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
  const abs = path.join(worktreePath, "docs", "setup.md");
  fs.appendFileSync(abs, "\nChanged after review.\n");

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
