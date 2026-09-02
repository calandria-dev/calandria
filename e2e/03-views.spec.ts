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

// Narrow desktop windows. The three tracks beside the transcript are fixed
// (236 + 352 + 430 = 1018 at the defaults) and only the transcript flexes, so
// below ~1400px it was the transcript — the one pane being read — that absorbed
// the whole shortfall: 262px at 1280, 6px at 1024. The shell now sheds a side
// column instead, projects then tasks then the diff rail, at the widths in
// AUTO_COLLAPSE_BELOW (app/shell/types.ts).
//
// 1024x768 is not hypothetical: it is the GitHub-hosted macOS and Windows
// runners' virtual display, which is what the Electron shell's window gets
// clamped to on two of the three desktop lanes. 800x600 is the tier below it,
// where the rail goes too. Both are driven here rather than only in the desktop
// suite so a regression is caught on the cheap Linux browser lane.
test.describe("auto-collapse on a narrow window", () => {
  const NARROW_TASK = "Narrow task";

  test.beforeAll(async ({ request }) => {
    const projects = await (await request.get("/api/projects")).json();
    const proj = projects.find((p: { name: string }) => p.name === PROJECT);
    const task = await createTask(request, { projectId: proj.id, title: NARROW_TASK });
    await sendMessage(request, task.id);
    await waitForIdle(request, task.id);
  });

  // Which of the three side tracks are panels rather than 30px spines, read in
  // one pass so they describe a single layout.
  type Tracks = { proj: boolean; task: boolean; rail: boolean; spines: number };
  const tracks = (page: import("@playwright/test").Page): Promise<Tracks> =>
    page.evaluate(() => ({
      proj: !!document.querySelector(".col-projects"),
      task: !!document.querySelector(".col-tasks .task-scroll"),
      rail: !!document.querySelector(".sess-rail"),
      spines: document.querySelectorAll(".col-rail").length,
    }));

  // Polled, not read once. A viewport change reaches the shell through
  // matchMedia and a reload remounts the whole session pane, so a single
  // evaluate can land mid-render — the rail is a sibling of the transcript and
  // has been seen missing for a frame after `.transcript .tw` is already
  // visible. Same reason the full-width spec above polls its widths.
  const expectTracks = async (page: import("@playwright/test").Page, want: Tracks) => {
    await expect
      .poll(() => tracks(page), { message: `shell never settled into ${JSON.stringify(want)}` })
      .toEqual(want);
  };

  // The transcript's own measure, inside its 28px gutters: the width a message
  // is actually laid out into, and the number this whole policy exists to keep
  // off the floor.
  const measure = (page: import("@playwright/test").Page) =>
    page.evaluate(() => document.querySelector(".transcript .tw")?.getBoundingClientRect().width ?? 0);

  test("sheds the side columns as the window narrows, and gives them back", async ({ page }) => {
    await gotoApp(page);
    await page.getByText(PROJECT).first().click();
    await listRow(page, NARROW_TASK).click();
    await expect(page.locator(".transcript .tw")).toBeVisible();

    // 1440: above every threshold, so the full three-column shell.
    await expectTracks(page, { proj: true, task: true, rail: true, spines: 0 });
    const wide = await measure(page);
    expect(wide).toBeGreaterThan(300);

    // 1024: projects and tasks are spines, the rail is still a real panel, and
    // the transcript has more room than it had at 1440 with all three open.
    await page.setViewportSize({ width: 1024, height: 768 });
    await expectTracks(page, { proj: false, task: false, rail: true, spines: 2 });
    const narrow = await measure(page);
    expect(narrow).toBeGreaterThan(wide);

    // 800: the rail goes too, and the transcript keeps growing rather than
    // shrinking — the whole point of shedding in this order.
    await page.setViewportSize({ width: 800, height: 600 });
    await expectTracks(page, { proj: false, task: false, rail: false, spines: 3 });
    expect(await measure(page)).toBeGreaterThan(narrow);

    // Back up: the policy is applied at render, never written into the persisted
    // Layout, so the user's own columns come straight back — and are still there
    // after a reload, which reads what was actually stored.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectTracks(page, { proj: true, task: true, rail: true, spines: 0 });

    await page.reload();
    await expectTracks(page, { proj: true, task: true, rail: true, spines: 0 });
  });

  // The spine's button has to mean something at a width the policy is collapsing
  // at, or it is a control that visibly does nothing. Expanding wins over the
  // policy for as long as the window stays this size; leaving the size and
  // coming back starts the policy over rather than remembering a decision made
  // at a width the user has since left.
  test("a column the policy tucked away still opens from its spine", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await gotoApp(page);

    const spine = page.getByTitle("Show projects panel");
    await expect(spine).toBeVisible();
    await spine.click();
    await expect(page.locator(".col-projects")).toBeVisible();

    // Still open through the re-render selecting a project causes: the override
    // is state, not a one-shot.
    await page.getByText(PROJECT).first().click();
    await expect(page.locator(".col-projects")).toBeVisible();

    // The tasks column is on the same policy, and its spine works the same way.
    await page.getByTitle("Show tasks panel").click();
    await expect(listRow(page, NARROW_TASK)).toBeVisible();

    // Leave the breakpoint and come back: both are tucked away again.
    //
    // The leaving has to be SEEN. Both columns are open at 1024 (reopened) and
    // at 1440 (nothing shed), so the DOM is identical at the two widths and a
    // `.col-projects` check passes before the browser has so much as evaluated
    // the new width. matchMedia reports a crossing per rendered frame, and a
    // loaded runner can take the second resize before the first has had one —
    // to the app the window then never left 1024, and nothing, in the app or
    // out of it, could tell it otherwise (#104). `data-shed` is the policy as
    // the app currently sees it; waiting for it is waiting for the app to have
    // observed the width, which is the precondition the return leg asserts on.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator("[data-shed]")).toHaveAttribute("data-shed", "");
    await expect(page.locator(".col-projects")).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator("[data-shed]")).toHaveAttribute("data-shed", "proj task");
    await expect(page.getByTitle("Show projects panel")).toBeVisible();
    await expect(page.getByTitle("Show tasks panel")).toBeVisible();
  });

  // The same window is also SHORT, which the shedding policy above says nothing
  // about — it is a width policy. The rail's scroll box carried a 40px
  // `padding-bottom`, incompressible, so `min-height:0` could not shrink it past
  // 40px and, being `position:relative`, it painted over its next sibling
  // instead of scrolling. With the terminal drawer taking 300px off a 768px
  // display that overhang landed across the drawer's own button bar and ate the
  // clicks on it, which is how it surfaced: as a 30s `locator.click` timeout on
  // the desktop lanes, whose windows the runners clamp to exactly this size.
  // Clicking Hide THROUGH the drawer is the assertion — an intercepted click
  // times out rather than failing on the toggle.
  test("the diff rail does not overhang the terminal drawer's buttons", async ({ page }) => {
    // Selected at the full width, since at 1024 both side columns are spines.
    await gotoApp(page);
    await page.getByText(PROJECT).first().click();
    await listRow(page, NARROW_TASK).click();
    await expect(page.locator(".tc-scroll")).toBeVisible();

    // 600 tall, not 768: at 768 the wrapped toolbar still just fits above the
    // drawer, so the case would pass with the clip removed. This is the height
    // the overhang is 107px at.
    await page.setViewportSize({ width: 1024, height: 600 });
    // Both spines expanded back out, which the policy above allows and which is
    // the WORST case for this pane rather than an exotic one: 236 + 352 leaves
    // the rail on SESS_MAIN_MIN's floor at ~74px, where `.tc-bar`'s
    // `flex-wrap:wrap` turns one toolbar row into five and the rail's own
    // children stop fitting its height. Reached from the shell's own controls,
    // so nothing here depends on a layout the user cannot actually produce.
    await page.getByTitle("Show projects panel").click();
    await page.getByTitle("Show tasks panel").click();
    await expect(page.locator(".col-projects")).toBeVisible();

    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    const drawer = page.locator(".term-drawer");
    await expect(drawer).toBeVisible();

    // Nothing above may reach into the drawer: it is the last thing in the
    // column and every pane before it is supposed to have stopped.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const top = document.querySelector(".term-drawer")!.getBoundingClientRect().top;
          // Every box in the rail, not just the scroll one: the element that
          // actually ate the click on the desktop lanes was `.tc-bar`, the
          // toolbar ABOVE it, which `flex:0 0 auto` makes incompressible.
          return Math.max(
            ...[...document.querySelectorAll(".sess-rail, .tc-root, .tc-bar, .tc-scroll")]
              .map((el) => el.getBoundingClientRect().bottom - top),
          );
        }),
      { message: "the diff rail never stopped overhanging .term-drawer" })
      .toBeLessThanOrEqual(0);

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
