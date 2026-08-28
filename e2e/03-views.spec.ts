// Task layout views: the list ⇄ board (kanban) toggle, status columns, and
// status-driven placement. Tasks are seeded via the API (creation through the
// UI is covered by 02-core-flow); this spec is about how they render.

import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, sendMessage, uid, waitForIdle } from "./helpers";

const PROJECT = `Views ${uid()}`;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("views") });
  const a = await createTask(request, { projectId: project.id, title: "Alpha task" });
  const b = await createTask(request, { projectId: project.id, title: "Beta task" });
  await createTask(request, { projectId: project.id, title: "Gamma task" });
  // Distinct statuses so the board has populated columns.
  await request.patch(`/api/tasks/${a.id}`, { data: { status: "in_progress" } });
  await request.patch(`/api/tasks/${b.id}`, { data: { status: "done" } });
});

// A task's title renders in several places at once (list row, board card,
// session header) — scope to the list row title (.ttitle) / board card title
// to stay out of Playwright strict-mode violations.
const listRow = (page: import("@playwright/test").Page, title: string) =>
  page.locator(".ttitle").filter({ hasText: title });

test("list view shows every task grouped by status", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle("List view").click();

  await expect(listRow(page, "Alpha task")).toBeVisible();
  await expect(listRow(page, "Beta task")).toBeVisible();
  await expect(listRow(page, "Gamma task")).toBeVisible();
});

test("board view shows kanban columns with cards in the right places", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle("Board view").click();

  // Columns render (`.bcol.k-<key>` per TaskBoard.tsx), cards in the column
  // matching their status.
  await expect(page.locator(".bcol.k-not_started")).toBeVisible();
  await expect(page.locator(".bcol.k-in_progress")).toBeVisible();
  await expect(page.locator(".bcol.k-done")).toBeVisible();
  await expect(page.locator(".bcol.k-in_progress").getByText("Alpha task")).toBeVisible();
  await expect(page.locator(".bcol.k-done").getByText("Beta task")).toBeVisible();
  await expect(page.locator(".bcol.k-not_started").getByText("Gamma task")).toBeVisible();

  // A status change moves the card between columns.
  await page.request.patch(`/api/tasks/${await idOf(page, "Gamma task")}`, { data: { status: "done" } });
  await page.reload();
  await page.getByText(PROJECT).first().click();
  await expect(page.locator(".bcol.k-done").getByText("Gamma task")).toBeVisible();

  // And the toggle goes back to list view — in board layout the switch is the
  // board workspace's own "List"/"Board" segmented control, not the task
  // column's icon toggle (that column is replaced by the full-width board).
  await page.getByRole("tab", { name: "List", exact: true }).click();
  await expect(page.locator(".bcol.k-done")).toBeHidden();
  await expect(listRow(page, "Alpha task")).toBeVisible();
});

// Appearance → Text width. Needs a viewport wide enough that the session pane is
// bigger than the 760px reading measure, otherwise "reading" and "full" render
// identically and the test would pass on a no-op. Default columns are
// 236 + 352 + 430 = 1018px, so 2000 leaves ~980 for the transcript.
test.describe("full-width text", () => {
  test.use({ viewport: { width: 2000, height: 900 } });

  const READING = 760;
  const WIDE_TASK = "Width task";

  // The transcript only exists once a task has a session — an unstarted one shows
  // the "Start session" hero instead. Its own task so the layout tests above keep
  // their fixtures untouched.
  test.beforeAll(async ({ request }) => {
    const projects = await (await request.get("/api/projects")).json();
    const proj = projects.find((p: { name: string }) => p.name === PROJECT);
    const task = await createTask(request, { projectId: proj.id, title: WIDE_TASK });
    await sendMessage(request, task.id);
    await waitForIdle(request, task.id);
  });

  // The transcript column and the composer share the measure, so both move
  // together. Read in ONE page.evaluate rather than three boundingBox() calls,
  // and polled: the three widths are supposed to describe a single layout, and
  // React remounts the transcript moments after a reload, so a handle Playwright
  // resolved could be replaced before it measured and come back null — the
  // element was there the whole time (connected, display:block, 981px wide),
  // it just wasn't the same node any more. That raced ~10% of the time and
  // failed on the deref, not on an assertion.
  type Widths = { pane: number; tw: number; composer: number };
  const columnWidths = async (page: import("@playwright/test").Page): Promise<Widths> => {
    let last: Widths | null = null;
    await expect
      .poll(async () => {
        last = await page.evaluate(() => {
          const pane = document.querySelector(".transcript");
          const tw = document.querySelector(".transcript .tw");
          const composer = document.querySelector(".composer-inner");
          if (!pane || !tw || !composer) return null;
          return {
            pane: pane.getBoundingClientRect().width,
            tw: tw.getBoundingClientRect().width,
            composer: composer.getBoundingClientRect().width,
          };
        });
        return last?.pane ?? 0;
      }, { message: "transcript never settled into a measurable layout" })
      .toBeGreaterThan(0);
    return last!;
  };

  test("widens the transcript to the pane and persists across a reload", async ({ page }) => {
    await gotoApp(page);
    await page.getByText(PROJECT).first().click();
    await listRow(page, WIDE_TASK).click();
    await expect(page.locator(".transcript .tw")).toBeVisible();

    // Default off: the capped reading measure, narrower than the pane it sits in.
    const before = await columnWidths(page);
    expect(before.tw).toBeCloseTo(READING, 0);
    expect(before.composer).toBeCloseTo(READING, 0);
    expect(before.pane).toBeGreaterThan(READING + 50);

    // Two "Appearance" buttons open the same panel (projects rail + titlebar).
    await page.getByTitle("Appearance").first().click();
    await page.getByRole("button", { name: "Full", exact: true }).click();

    const after = await columnWidths(page);
    expect(after.tw).toBeCloseTo(after.pane, 0);
    expect(after.tw).toBeGreaterThan(READING);
    expect(after.composer).toBeGreaterThan(READING);

    // Persisted, not just in-memory: survives a full reload of the app.
    await page.reload();
    await expect(page.locator(".transcript .tw")).toBeVisible();
    const reloaded = await columnWidths(page);
    expect(reloaded.tw).toBeCloseTo(after.tw, 0);

    // And it toggles back off.
    await page.getByTitle("Appearance").first().click();
    await page.getByRole("button", { name: "Reading", exact: true }).click();
    expect((await columnWidths(page)).tw).toBeCloseTo(READING, 0);
  });
});

// The other end of the same measure. Every other spec here runs at a viewport
// wider than the three fixed columns put together (236 + 352 + 430 = 1018), so
// none of them could see what happens just below it: the rail is a fixed grid
// track, so the transcript — the only flexible one — absorbed the whole
// shortfall and laid out at ~0px. The messages stayed in the DOM and in the
// accessibility tree the entire time, which is what made it so hard to read:
// the session pane was simply blank, and Playwright called every message
// "hidden" (a zero-area box is not visible) rather than missing.
//
// 1024x768 is the exact size that caught it — the GitHub-hosted macOS and
// Windows runners' virtual display, which is what the Electron shell's window
// gets clamped to. The desktop e2e lane has no viewport of its own (it drives a
// real OS window), so its transcript assertion failed there and nowhere else;
// this is the cheap Linux-side pin for the layout rule underneath it.
test.describe("narrow desktop window", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  const NARROW_TASK = "Narrow task";

  test.beforeAll(async ({ request }) => {
    const projects = await (await request.get("/api/projects")).json();
    const proj = projects.find((p: { name: string }) => p.name === PROJECT);
    const task = await createTask(request, { projectId: proj.id, title: NARROW_TASK });
    await sendMessage(request, task.id);
    await waitForIdle(request, task.id);
  });

  test("the rail yields rather than squeezing the transcript to nothing", async ({ page }) => {
    await gotoApp(page);
    await page.getByText(PROJECT).first().click();
    await listRow(page, NARROW_TASK).click();

    // The assertion the desktop lane makes, at the width that broke it: a
    // streamed message is genuinely on screen, not merely in the document.
    await expect(page.getByText("Mock turn complete").first()).toBeVisible();

    // And the rail did not simply disappear to make room — both panes are real.
    const panes = await page.evaluate(() => ({
      main: document.querySelector(".sess-main")!.getBoundingClientRect().width,
      rail: document.querySelector(".sess-rail")!.getBoundingClientRect().width,
      tw: document.querySelector(".transcript .tw")!.getBoundingClientRect().width,
    }));
    expect(panes.main).toBeGreaterThan(100);
    expect(panes.rail).toBeGreaterThan(100);
    // The transcript's own measure, inside its 28px gutters, is what a message
    // is laid out into. Zero here is the bug however wide .sess-main reads.
    expect(panes.tw).toBeGreaterThan(0);
  });

  // The same window is also SHORT, and the rail's scroll box had a 40px
  // `padding-bottom` — incompressible, so `min-height:0` could not shrink it
  // past 40px and, being `position:relative`, it painted over its next sibling
  // instead of scrolling. With the terminal drawer taking 300px off a 768px
  // display that overhang landed across the drawer's own button bar and ate the
  // clicks on it. Clicking Hide through the drawer is the assertion: an
  // intercepted click times out rather than failing on the toggle.
  test("the diff rail does not overhang the terminal drawer's buttons", async ({ page }) => {
    await gotoApp(page);
    await page.getByText(PROJECT).first().click();
    await listRow(page, NARROW_TASK).click();
    await expect(page.locator(".tc-scroll")).toBeVisible();

    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    const drawer = page.locator(".term-drawer");
    await expect(drawer).toBeVisible();
    // Nothing above may reach into the drawer: it is the last thing in the
    // column and every pane before it is supposed to have stopped.
    const overhang = await page.evaluate(() => {
      const top = document.querySelector(".term-drawer")!.getBoundingClientRect().top;
      return document.querySelector(".tc-scroll")!.getBoundingClientRect().bottom - top;
    });
    expect(overhang).toBeLessThanOrEqual(0);

    await page.getByTitle("Hide terminal (the shell keeps running)").click();
    await expect(drawer).toHaveClass(/\bcollapsed\b/);
  });
});

async function idOf(page: import("@playwright/test").Page, title: string): Promise<string> {
  const projects = await (await page.request.get("/api/projects")).json();
  const proj = projects.find((p: { name: string }) => p.name === PROJECT);
  const detail = await (await page.request.get(`/api/projects/${proj.id}`)).json();
  return detail.tasks.find((t: { title: string }) => t.title === title).id;
}

// Phone layout: one pane at a time, with the bottom tab bar. Re-tapping the
// ACTIVE Board tab from inside a task pops back to the task list (the board
// root) the way a native tab bar pops its stack; it used to be a dead tap.
// Tapping Board from another tab only switches tabs — the session you left is
// still where you left it — so the pop takes one tap from Board, two from Diffs.
test.describe("mobile tab bar", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("re-tapping Board inside a task returns to the task list", async ({ page }) => {
    await gotoApp(page);
    // A phone boots straight into the first project's task pane (there's no
    // projects column beside it), so step back out before picking the fixture.
    await expect(page.locator(".mtabbar")).toBeVisible();
    const backToProjects = page.getByRole("button", { name: "Back to projects" });
    if (await backToProjects.isVisible()) await backToProjects.click();
    await page.getByText(PROJECT).first().click();
    await page.getByTitle("List view").click();
    await listRow(page, "Alpha task").click();
    const backToTasks = page.getByRole("button", { name: "Back to tasks" });
    await expect(backToTasks).toBeVisible();

    const tab = (label: string) => page.locator(".mtabbar-item").filter({ hasText: label });
    await expect(tab("Board")).toHaveClass(/\bon\b/);
    await tab("Board").click();
    await expect(backToTasks).toBeHidden();
    await expect(listRow(page, "Alpha task")).toBeVisible();
    await expect(tab("Board")).toHaveClass(/\bon\b/);

    // From Diffs, the first Board tap restores the session; the second pops.
    await listRow(page, "Alpha task").click();
    await expect(backToTasks).toBeVisible();
    await tab("Diffs").click();
    await expect(backToTasks).toBeHidden();
    await tab("Board").click();
    await expect(backToTasks).toBeVisible();
    await tab("Board").click();
    await expect(backToTasks).toBeHidden();
    await expect(listRow(page, "Alpha task")).toBeVisible();
  });
});

// Settings on a phone: the section nav is a horizontal chip rail. `.nav-item`
// is `width:100%` for the desktop sidebar, which in a flex row made every chip
// a full screen wide — one section visible, the other nine reachable only by a
// horizontal scroll with nothing on screen to suggest it existed.
test.describe("mobile settings nav", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("several sections are on screen at once and stay reachable", async ({ page }) => {
    await gotoApp(page);
    // Wait for the phone layout to mount before reading which pane is up — a
    // phone boots into the first project's task pane, and Settings hangs off
    // the projects column behind it.
    await expect(page.locator(".mtabbar")).toBeVisible();
    const backToProjects = page.getByRole("button", { name: "Back to projects" });
    if (await backToProjects.isVisible()) await backToProjects.click();
    await page.getByTitle("App settings").click();

    const chips = page.locator(".settings-nav-list .nav-item");
    await expect(chips.first()).toBeVisible();
    // Shrink-to-fit, not full-bleed: several chips share the row, and the next
    // one is cut off by the right edge — that clipped chip IS the affordance
    // that says the rail scrolls.
    const boxes = await chips.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right })));
    expect(boxes.every((b) => b.right - b.left < 390)).toBe(true);
    expect(boxes.filter((b) => b.left >= 0 && b.right <= 390).length).toBeGreaterThanOrEqual(2);
    expect(boxes.some((b) => b.left < 390 && b.right > 390)).toBe(true);

    // A section past the fold still selects, and gets scrolled into view.
    const agents = chips.filter({ hasText: "Agents" });
    await agents.click();
    await expect(agents).toHaveClass(/\bactive\b/);
    await expect(page.getByText("Each task runs as a coding agent.")).toBeVisible();
    const box = await agents.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});
