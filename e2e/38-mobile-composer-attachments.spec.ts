// Attaching a file from the session composer on a phone. Under the 760px
// breakpoint the composer footer (.comp-foot) and its "attach" hint are
// hidden, so the composer carries its own paperclip button (.comp-attach) in
// the input row, visible on a phone only.
//
// Rotating a phone across the breakpoint renders a different tree in
// app/Shell.tsx, which remounts the composer. The draft's attachments live in
// a per-task in-memory store (useAttachments with a persistKey), so the chip
// has to survive both crossings. After the send, the user message in the
// transcript shows the file as a named chip.

import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, sendMessage, uid, waitForIdle } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const FILE = "phone-notes.txt";

let projectId: string;
let taskId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: `Mobile composer ${uid()}`, repoPath: makeFixtureRepo("mobile-composer-attachments") });
  projectId = project.id;
  // The composer is disabled until the task has started, so run one turn first.
  const task = await createTask(request, { projectId, title: `Phone attach ${uid()}` });
  taskId = task.id;
  await sendMessage(request, taskId);
  await waitForIdle(request, taskId);
});

// The app has seen a width once `.app.mobile` matches the side of the
// breakpoint the test moved to (matchMedia reports once per rendered frame).
async function resize(page: Page, width: number, height: number, mobile: boolean): Promise<void> {
  await page.setViewportSize({ width, height });
  await expect(page.locator(".app.mobile")).toHaveCount(mobile ? 1 : 0);
}

test("a file attached on a phone survives rotating across the breakpoint and sends", async ({ page }) => {
  await gotoApp(page);
  await page.goto(`/?project=${projectId}&task=${taskId}`);

  const composer = page.locator(".comp-input");
  await expect(composer).toBeVisible();
  await expect(page.locator(".app.mobile")).toHaveCount(1);

  // The footer's attach hint is gone on a phone; the in-row button replaces it.
  await expect(page.locator(".comp-attach")).toBeVisible();
  await expect(page.locator(".comp-foot")).toBeHidden();

  await page.locator('input[type=file][aria-label="Attach files"]').setInputFiles({
    name: FILE,
    mimeType: "text/plain",
    buffer: Buffer.from("from a phone"),
  });
  await expect(page.locator(".attach-chip .attach-file")).toContainText(FILE);
  await expect(page.locator(".attach-chip.uploading")).toHaveCount(0);

  // Landscape is wider than the breakpoint, so this is the desktop layout.
  await resize(page, 844, 390, false);
  await expect(page.locator(".attach-chip .attach-file")).toContainText(FILE);
  await expect(page.locator(".attach-chip.uploading")).toHaveCount(0);

  await resize(page, 390, 844, true);
  await expect(page.locator(".attach-chip .attach-file")).toContainText(FILE);
  await expect(page.locator(".comp-attach")).toBeVisible();

  await composer.click();
  await page.keyboard.type("see the attached notes");
  await page.locator(".send").click();

  const message = page.locator(".msg").filter({ hasText: "see the attached notes" });
  await expect(message.locator(".msg-attachments .file-chip")).toContainText(FILE);
  await expect(page.locator(".attach-chip")).toHaveCount(0);
});
