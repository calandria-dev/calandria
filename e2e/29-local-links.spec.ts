// A markdown link that names a file in the task's checkout (`app/Markdown.tsx`
// with `links`, `lib/localLink.ts`). A text file opens in the collaboration
// modal in place; an image points at the raw file route in a new tab; a web
// link is left alone. Only a browser can say what a click does with an anchor.

import { expect, test } from "@playwright/test";
import { ensureOnboarded, gotoApp, runTaskToCompletion, sendMessage, uid, waitForIdle } from "./helpers";

const MESSAGE = [
  "e2e:write=docs/guide.md:# Guide heading",
  "",
  "Read [the guide](docs/guide.md), see [the shot](shots/a.png),",
  "or visit [the site](https://example.com/docs/guide.md).",
].join("\n");

let projectId: string;
let taskId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const { project, task } = await runTaskToCompletion(request, { name: "local-links", title: `Local links ${uid()}` });
  projectId = project.id;
  taskId = task.id;
  // A follow-up: the opening user turn is the fixed initial prompt. The user
  // bubble renders through the same Markdown component the agent's does.
  await sendMessage(request, taskId, MESSAGE);
  await waitForIdle(request, taskId);
});

test("a link to a text file opens it in the collaboration modal", async ({ page }) => {
  await gotoApp(page);
  await page.goto(`/?project=${projectId}&task=${taskId}`);

  const link = page.locator(".msg .md a", { hasText: "the guide" }).first();
  await expect(link).toBeVisible();
  await expect(link).toHaveClass(/md-file/);
  await link.click();

  const modal = page.locator(".modal", { hasText: "Collaborate on document" });
  await expect(modal).toBeVisible();
  await expect(modal.locator(".collab-render h1")).toHaveText("Guide heading");
  // The click was handled in place: still one page, on the same task.
  expect(page.url()).toContain(`task=${taskId}`);
});

test("an image link targets the raw file route and a web link is untouched", async ({ page }) => {
  await gotoApp(page);
  await page.goto(`/?project=${projectId}&task=${taskId}`);

  const image = page.locator(".msg .md a", { hasText: "the shot" }).first();
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("href", `/api/tasks/${taskId}/file/raw?path=shots%2Fa.png`);
  await expect(image).toHaveAttribute("target", "_blank");

  const web = page.locator(".msg .md a", { hasText: "the site" }).first();
  await expect(web).toHaveAttribute("href", "https://example.com/docs/guide.md");
  await expect(web).toHaveAttribute("target", "_blank");
  await expect(web).not.toHaveClass(/md-file/);
});
