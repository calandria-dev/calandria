// A markdown link that names a file in the task's checkout (`app/Markdown.tsx`
// with `links`, `lib/localLink.ts`). A text file opens in the collaboration
// modal in place; an image points at the raw file route in a new tab; a web
// link is left alone. Only a browser can say what a click does with an anchor.
// A markdown image naming a checkout file renders inline from the raw route,
// including from a gitignored build directory; one escaping the checkout
// renders a placeholder and is never requested.

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ensureOnboarded, getTask, gotoApp, runTaskToCompletion, sendMessage, uid, waitForIdle } from "./helpers";

const MESSAGE = [
  "e2e:write=docs/guide.md:# Guide heading",
  "",
  "Read [the guide](docs/guide.md), see [the shot](shots/a.png),",
  "or visit [the site](https://example.com/docs/guide.md).",
].join("\n");

const FIXTURE = path.join(__dirname, "..", "tests", "fixtures", "button-module-back.png");
const SHOT = "build/checks/button-module-back.png";

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

  // An agent's render output, gitignored like any build product.
  const worktree: string = (await getTask(request, taskId)).worktree_path;
  fs.mkdirSync(path.join(worktree, "build", "checks"), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(worktree, SHOT));
  fs.appendFileSync(path.join(worktree, ".gitignore"), "\nbuild/\n");
  fs.writeFileSync(path.join(path.dirname(worktree), "outside.png"), fs.readFileSync(FIXTURE));
  await sendMessage(request, taskId, [
    `Relative: ![back render](${SHOT})`,
    "",
    `Absolute: ![abs render](${path.join(worktree, SHOT)})`,
    "",
    "Escape: ![escape render](../outside.png)",
    "",
    `Outside: ![outside render](${path.join(path.dirname(worktree), "outside.png")})`,
  ].join("\n"));
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

test("a worktree image renders inline and an escaping one never loads", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/file/raw")) requested.push(decodeURIComponent(r.url())); });
  await gotoApp(page);
  await page.goto(`/?project=${projectId}&task=${taskId}`);

  const src = `/api/tasks/${taskId}/file/raw?path=${encodeURIComponent(SHOT)}`;
  for (const alt of ["back render", "abs render"]) {
    const img = page.locator(`.msg .md img[alt="${alt}"]`).first();
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute("src", src);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1568);
    // A click opens the full size in a new tab.
    await expect(img.locator("xpath=..")).toHaveAttribute("href", src);
  }

  for (const alt of ["escape render", "outside render"]) {
    const missing = page.locator(".msg .md .md-img-missing", { hasText: alt }).first();
    await expect(missing).toBeVisible();
    await expect(missing).toContainText("image not found");
  }
  await expect(page.locator(".msg .md img[alt='escape render'], .msg .md img[alt='outside render']")).toHaveCount(0);
  expect(requested.filter((u) => u.includes("outside.png"))).toEqual([]);
});
