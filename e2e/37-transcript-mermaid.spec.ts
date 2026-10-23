// A ```mermaid fence in a persisted transcript message renders as a diagram
// (`<Markdown diagrams>` in app/shell/Transcript.tsx). mermaid draws into the
// real DOM, so only a browser can say the fence became an SVG.

import { expect, test } from "@playwright/test";
import { ensureOnboarded, gotoApp, runTaskToCompletion, sendMessage, uid, waitForIdle } from "./helpers";

const MESSAGE = ["Here is the flow:", "", "```mermaid", "flowchart LR", "  Alpha --> Beta", "```"].join("\n");

let projectId: string;
let taskId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const { project, task } = await runTaskToCompletion(request, { name: "transcript-mermaid", title: `Transcript mermaid ${uid()}` });
  projectId = project.id;
  taskId = task.id;
  // A follow-up, since the opening user turn is the fixed initial prompt and
  // carries no fence of its own.
  await sendMessage(request, taskId, MESSAGE);
  await waitForIdle(request, taskId);
});

test("a mermaid fence in a message renders as a diagram", async ({ page }) => {
  await gotoApp(page);
  await page.goto(`/?project=${projectId}&task=${taskId}`);

  const diagram = page.locator(".msg [data-testid=mermaid]").first();
  await expect(diagram).toBeVisible();
  // mermaid loads on first use, so wait for the SVG itself.
  const svg = diagram.locator(".md-mermaid-svg svg");
  await expect(svg).toBeVisible({ timeout: 15_000 });
  await expect(svg).toContainText("Alpha");
  await expect(svg).toContainText("Beta");
  await expect(diagram.locator(".md-mermaid-err")).toHaveCount(0);
});
