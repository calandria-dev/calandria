// File attachments on the New task and Edit task dialogs
// (app/shell/attachments.tsx, lib/uploadTypes.ts). A file attached while
// filling out either dialog uploads right away, renders as a chip, and is
// written into the description as an "[Attached ...]" marker line on save.
// The task header (.hero) then shows the same file as a strip, and the list
// row's .tdesc gets a paperclip count. No agent turn ever needs to run: the
// whole feature lives in the dialogs and the stored description, so these
// tests never start a session.

import { expect, test, type Page } from "@playwright/test";
import { createProject, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Attachments ${uid()}`;
// A 1x1 transparent PNG, small enough to embed as a literal.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let projectId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("attachments") });
  projectId = project.id;
});

const openProject = async (page: Page) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle("List view").click();
};

const fileInput = (page: Page) => page.locator('input[type=file][aria-label="Attach files"]');

// The chip carries an "uploading" status class until the upload settles;
// Create/Save stays disabled until every chip has left that state.
const waitForUploads = (page: Page) => expect(page.locator(".attach-chip.uploading")).toHaveCount(0);

const card = (page: Page, title: string) =>
  page.locator(".task-row").filter({ has: page.locator(".ttitle", { hasText: title }) });

async function taskIdByTitle(request: import("@playwright/test").APIRequestContext, title: string): Promise<string> {
  const detail = await (await request.get(`/api/projects/${projectId}`)).json();
  const task = detail.tasks.find((t: { title: string }) => t.title === title);
  expect(task).toBeTruthy();
  return task.id;
}

test("a file attached in the New task dialog lands on the task", async ({ page, request }) => {
  const title = `Attach a text file ${uid()}`;

  await openProject(page);
  await page.getByRole("button", { name: "Task", exact: true }).click();
  await page.getByPlaceholder("e.g. Add rate-limiting to auth endpoints").fill(title);
  await page.getByPlaceholder(/Describe the feature or task/).fill("See the attached notes.");
  await fileInput(page).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.locator(".attach-chip .attach-file")).toContainText("notes.txt");
  await waitForUploads(page);
  await page.getByRole("button", { name: "Create task" }).click();

  // The hero (the new task is selected automatically) shows the file as a
  // named chip, and the list row carries a paperclip count.
  await expect(page.locator(".hero .msg-attachments .file-chip")).toContainText("notes.txt");
  await expect(card(page, title).locator(".tdesc-att")).toContainText("1");

  const taskId = await taskIdByTitle(request, title);
  const task = await (await request.get(`/api/tasks/${taskId}`)).json();
  expect(task.description).toMatch(/\[Attached file: .*notes\.txt\]$/);
});

test("an image attached shows as a thumbnail", async ({ page, request }) => {
  const title = `Attach an image ${uid()}`;

  await openProject(page);
  await page.getByRole("button", { name: "Task", exact: true }).click();
  await page.getByPlaceholder("e.g. Add rate-limiting to auth endpoints").fill(title);
  await page.getByPlaceholder(/Describe the feature or task/).fill("See the attached screenshot.");
  await fileInput(page).setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  });
  await expect(page.locator(".attach-chip.image")).toBeVisible();
  await waitForUploads(page);
  await page.getByRole("button", { name: "Create task" }).click();

  const img = page.locator(".hero .msg-attachments img");
  await expect(img).toBeVisible();
  const src = await img.getAttribute("src");
  expect(src).toBeTruthy();
  const res = await page.request.get(src!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/png");

  const taskId = await taskIdByTitle(request, title);
  const task = await (await request.get(`/api/tasks/${taskId}`)).json();
  expect(task.description).toMatch(/\[Attached image: .*pixel\.png\]$/);
});

test("the Edit dialog shows the attachment and can remove it", async ({ page, request }) => {
  const title = `Attach then remove it ${uid()}`;

  await openProject(page);
  await page.getByRole("button", { name: "Task", exact: true }).click();
  await page.getByPlaceholder("e.g. Add rate-limiting to auth endpoints").fill(title);
  await page.getByPlaceholder(/Describe the feature or task/).fill("Has a file to remove later.");
  await fileInput(page).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await waitForUploads(page);
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.locator(".hero .msg-attachments .file-chip")).toContainText("notes.txt");

  // Unstarted task: TaskHero's own Edit button, not the session header's.
  await page.getByTitle("Edit title & description before starting").click();
  const dialog = page.locator(".modal");
  await expect(dialog.getByText("Edit task")).toBeVisible();
  const chip = dialog.locator(".attach-chip").filter({ hasText: "notes.txt" });
  await expect(chip).toBeVisible();

  await chip.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(chip).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save changes" }).click();

  await expect(page.locator(".hero .msg-attachments .file-chip")).toHaveCount(0);
  const taskId = await taskIdByTitle(request, title);
  const task = await (await request.get(`/api/tasks/${taskId}`)).json();
  expect(task.description).not.toContain("[Attached");
});

test("cancelling the New task dialog discards the draft upload", async ({ page, request }) => {
  const title = `Cancelled draft ${uid()}`;
  // The dialog fires a best-effort DELETE of its draft on Cancel
  // (app/shell/modals.tsx). There is no way from the browser to look inside
  // the server's upload dir and confirm the draft's bytes are gone, so this
  // only proves Cancel never lets the draft become a real task; the DELETE
  // call itself is covered by app/shell/modals.tsx's own close() path.
  const uploadDeletes: number[] = [];
  page.on("response", (res) => {
    if (res.request().method() === "DELETE" && /\/api\/uploads\//.test(res.url())) uploadDeletes.push(res.status());
  });

  await openProject(page);
  await page.getByRole("button", { name: "Task", exact: true }).click();
  await page.getByPlaceholder("e.g. Add rate-limiting to auth endpoints").fill(title);
  await fileInput(page).setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("discarded") });
  await waitForUploads(page);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  // Cancel only ever discards the draft; a task is minted solely by "Create
  // task", so this is really asserting Cancel didn't also create one.
  const list = await (await request.get("/api/tasks")).json();
  expect(list.tasks.some((t: { title: string }) => t.title === title)).toBe(false);
  await expect.poll(() => uploadDeletes).toEqual([200]);
});
