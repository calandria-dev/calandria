// The copy button on a fenced code block (`app/Markdown.tsx`). Hover reveals
// it through CSS and the click reads the real clipboard, so only a browser can
// say whether it appears over the block and carries the block's source.

import { expect, test } from "@playwright/test";
import { ensureOnboarded, gotoApp, runTaskToCompletion, sendMessage, uid, waitForIdle } from "./helpers";

const SOURCE = "const answer = 42;\nconsole.log(answer);";
const MESSAGE = ["Here is the snippet:", "", "```ts", SOURCE, "```"].join("\n");

let projectId: string;
let taskId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const { project, task } = await runTaskToCompletion(request, { name: "code-copy", title: `Code copy ${uid()}` });
  projectId = project.id;
  taskId = task.id;
  // A follow-up, since the opening user turn is the fixed initial prompt and
  // carries no fence of its own.
  await sendMessage(request, taskId, MESSAGE);
  await waitForIdle(request, taskId);
});

test("a fenced block reveals a copy button on hover that copies its source", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await gotoApp(page);
  await page.goto(`/?project=${projectId}&task=${taskId}`);

  const block = page.locator(".md-pre").filter({ hasText: "const answer = 42;" }).first();
  await expect(block).toBeVisible();
  const button = block.locator(".md-copy");

  // Out of the way until the block is pointed at.
  await expect(button).toHaveCSS("opacity", "0");
  await block.hover();
  await expect(button).toHaveCSS("opacity", "1");

  // Inside the block's top right corner, so it never sits over the first line
  // of code or outside the frame.
  const box = (await button.boundingBox())!;
  const pre = (await block.locator("pre").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(pre.x + pre.width);
  expect(box.x).toBeGreaterThan(pre.x + pre.width / 2);
  expect(box.y).toBeGreaterThanOrEqual(pre.y);

  await button.click();
  await expect(button).toHaveAttribute("aria-label", "Copied");
  // The source, without the highlighter's markup and without the fence lines.
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SOURCE);
});

test("the button is reachable from the keyboard with no pointer over the block", async ({ page }) => {
  await gotoApp(page);
  await page.goto(`/?project=${projectId}&task=${taskId}`);

  const button = page.locator(".md-pre").filter({ hasText: "const answer = 42;" }).first().locator(".md-copy");
  await expect(button).toHaveCSS("opacity", "0");
  await button.focus();
  await expect(button).toHaveCSS("opacity", "1");
});
