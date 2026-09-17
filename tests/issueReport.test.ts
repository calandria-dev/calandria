// `report_issue` — the tool that files nothing.
//
// The whole feature rests on one property: a tool call DRAFTS, and only a click
// on the transcript card publishes. Everything pinned here is a way that could
// silently stop being true —
//   - the draft never reaches GitHub, and a dead `gh` costs the user nothing;
//   - a settled report cannot be sent a second time, so a stale tab or a double
//     click cannot open a duplicate issue on a public tracker;
//   - the text that gets sent is the USER'S edit, not the model's draft;
//   - a failed send keeps the report a draft, with the reason, so it is
//     retryable rather than lost;
//   - the card settles onto the call that raised it (the stdio-bridge path,
//     which has no tool_use id to correlate with).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { searchIssuesMock, createIssueMock, commentOnIssueMock } = vi.hoisted(() => ({
  searchIssuesMock: vi.fn(),
  createIssueMock: vi.fn(),
  commentOnIssueMock: vi.fn(),
}));

// Mocked at the exported-function boundary of lib/github.ts, the house pattern
// (tests/prState.test.ts). Nothing here should ever reach a real `gh`.
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  searchIssues: searchIssuesMock,
  createIssue: createIssueMock,
  commentOnIssue: commentOnIssueMock,
}));

import { addMessage, createProject, createTask, getIssueReport, listMessages } from "@/lib/store";
import { attachIssueReportToCall, isReportIssueTool } from "@/lib/issueReportCard";
import { draftIssueReport, dismissIssueReport, issueReportCard, submitIssueReport } from "@/lib/issueReports";
import { issueSearchTerms } from "@/lib/github";
import { POST as reportIssueEp } from "@/app/api/internal/agent-tools/report-issue/route";
import { GET as cardGet } from "@/app/api/issue-reports/[id]/route";
import { POST as submitEp } from "@/app/api/issue-reports/[id]/submit/route";
import type { IssueReportCard, ToolData } from "@/lib/types";

const NO_MATCHES = { ok: true as const, issues: [] };

function session(name: string) {
  const project = createProject({ name });
  return createTask({ project_id: project.id, title: "Session", description: "" });
}

const reportCall = (taskId: string, name = "mcp__calandria__report_issue") =>
  addMessage(taskId, 1, "tool", JSON.stringify({ name, title: "⚑ Drafting a report" } satisfies ToolData));

function readData(taskId: string, msgId: string): ToolData {
  return JSON.parse(listMessages(taskId).find((x) => x.id === msgId)!.content) as ToolData;
}

async function draft(taskId: string, over: Partial<{ kind: string; title: string; body: string }> = {}) {
  const task = { id: taskId, project_id: "p" } as never;
  return draftIssueReport(task, { kind: "bug", title: "Merge button does nothing", body: "Clicked merge, nothing happened.", ...over });
}

beforeEach(() => {
  searchIssuesMock.mockReset();
  createIssueMock.mockReset();
  commentOnIssueMock.mockReset();
  searchIssuesMock.mockResolvedValue(NO_MATCHES);
});

describe("issueSearchTerms", () => {
  it("strips what GitHub's query parser would read as an operator", () => {
    // A bare colon or quote is a qualifier, not a word: unsanitized, a title
    // like this turns a duplicate check into a syntax error or a zero-hit
    // `merge:conflict`, and the user is told there are no duplicates.
    expect(issueSearchTerms('merge: "conflict" in worktree')).toBe("merge conflict worktree");
    // Short words carry no signal and crowd the cap out.
    expect(issueSearchTerms("it is a bug in the merge flow")).toBe("bug the merge flow");
    expect(issueSearchTerms("a b c")).toBe("");
    expect(issueSearchTerms("one two three four five", 2)).toBe("one two");
  });
});

describe("isReportIssueTool", () => {
  it("matches every driver's spelling of the same tool, and nothing else", () => {
    expect(isReportIssueTool("mcp__calandria__report_issue")).toBe(true);
    expect(isReportIssueTool("calandria__report_issue")).toBe(true);
    expect(isReportIssueTool("report_issue")).toBe(true);
    expect(isReportIssueTool("mcp__calandria__suggest_task")).toBe(false);
    expect(isReportIssueTool(undefined)).toBe(false);
  });
});

describe("attachIssueReportToCall", () => {
  it("lands on the newest unclaimed report_issue row, one card per call", () => {
    const task = session("Settle");
    const first = reportCall(task.id);
    const second = reportCall(task.id);

    // Newest-first, so two reports raised in one turn get a card each rather
    // than stacking on the first row.
    expect(attachIssueReportToCall(task.id, "r2")).toBe(second.id);
    expect(attachIssueReportToCall(task.id, "r1")).toBe(first.id);
    expect(readData(task.id, second.id).issueReport).toEqual({ id: "r2" });
    expect(readData(task.id, first.id).issueReport).toEqual({ id: "r1" });

    // Nothing left unclaimed.
    expect(attachIssueReportToCall(task.id, "r3")).toBeNull();
  });

  it("ignores rows belonging to other tools", () => {
    const task = session("Settle-Miss");
    addMessage(task.id, 1, "tool", JSON.stringify({ name: "Bash", title: "$ ls" } satisfies ToolData));
    expect(attachIssueReportToCall(task.id, "r1")).toBeNull();
  });
});

describe("draftIssueReport", () => {
  it("drafts without filing, and says so", async () => {
    const task = session("Draft");
    const { report, text } = await draft(task.id);

    expect(report).toBeTruthy();
    expect(report!.status).toBe("draft");
    expect(report!.issue_number).toBeNull();
    // The single most important assertion in this file.
    expect(createIssueMock).not.toHaveBeenCalled();
    expect(commentOnIssueMock).not.toHaveBeenCalled();
    expect(text).toMatch(/NOTHING HAS BEEN FILED/);
  });

  it("puts possible duplicates in front of the user", async () => {
    const task = session("Dupes");
    searchIssuesMock.mockResolvedValue({
      ok: true,
      issues: [{ number: 42, title: "Merge does nothing", url: "https://github.com/o/r/issues/42", state: "OPEN" }],
    });
    const { report, text } = await draft(task.id);

    expect(issueReportCard(report!.id)!.matches).toHaveLength(1);
    expect(text).toContain("#42");
  });

  it("survives a dead gh — the report is kept, with the reason", async () => {
    const task = session("NoGh");
    searchIssuesMock.mockResolvedValue({ ok: false, error: "gh not found" });
    const { report, text } = await draft(task.id);

    // Best-effort by contract: a missing gh must not cost the user their report.
    expect(report!.status).toBe("draft");
    expect(report!.error).toBe("gh not found");
    expect(issueReportCard(report!.id)!.matches).toEqual([]);
    expect(text).toContain("gh not found");
  });

  it("refuses an empty title", async () => {
    const task = session("NoTitle");
    const { report, text } = await draft(task.id, { title: "   " });
    expect(report).toBeNull();
    expect(text).toMatch(/title is required/i);
  });

  it("is off when the instance points nowhere", async () => {
    // ISSUE_REPO is computed at import time, so the off path needs a fresh
    // module graph rather than a setter.
    vi.stubEnv("CALANDRIA_ISSUE_REPO", "off");
    vi.resetModules();
    const mod = await import("@/lib/issueReports");
    expect(mod.issueReportsEnabled()).toBe(false);
    const { report, text } = await mod.draftIssueReport({ id: "t", project_id: "p" } as never, { title: "x" });
    expect(report).toBeNull();
    expect(text).toMatch(/turned off/i);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe("submitIssueReport", () => {
  it("files a new issue with the USER'S edits, not the model's draft", async () => {
    const task = session("File");
    const { report } = await draft(task.id);
    createIssueMock.mockResolvedValue({ ok: true, number: 7, url: "https://github.com/o/r/issues/7" });

    const res = await submitIssueReport(report!.id, { title: "Merge button is inert", body: "Rewritten by the user." });

    expect(res.ok).toBe(true);
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Merge button is inert", body: "Rewritten by the user." })
    );
    const after = getIssueReport(report!.id)!;
    expect(after.status).toBe("filed");
    expect(after.issue_number).toBe(7);
    expect(after.issue_url).toBe("https://github.com/o/r/issues/7");
    // The edits are the record, not just the payload.
    expect(after.title).toBe("Merge button is inert");
  });

  it("appends to an existing issue, saying what it is", async () => {
    const task = session("Append");
    const { report } = await draft(task.id);
    commentOnIssueMock.mockResolvedValue({ ok: true, number: 42, url: "https://github.com/o/r/issues/42#c1" });

    const res = await submitIssueReport(report!.id, { issueNumber: 42 });

    expect(res.ok).toBe(true);
    expect(createIssueMock).not.toHaveBeenCalled();
    const arg = commentOnIssueMock.mock.calls[0][0];
    expect(arg.number).toBe(42);
    // A bare paste under someone else's title reads as a non-sequitur.
    expect(arg.body).toContain("Also hit this");
    expect(arg.body).toContain("Merge button does nothing");
    expect(getIssueReport(report!.id)!.status).toBe("commented");
  });

  it("cannot send the same report twice", async () => {
    const task = session("Twice");
    const { report } = await draft(task.id);
    createIssueMock.mockResolvedValue({ ok: true, number: 7, url: "https://github.com/o/r/issues/7" });

    await submitIssueReport(report!.id, {});
    const second = await submitIssueReport(report!.id, {});

    // The public artifact exists now; a stale tab must not be able to make another.
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already/i);
    expect(createIssueMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed send as a retryable draft, with the edits and the reason", async () => {
    const task = session("Fail");
    const { report } = await draft(task.id);
    createIssueMock.mockResolvedValue({ ok: false, error: "gh: not signed in" });

    const res = await submitIssueReport(report!.id, { title: "Edited before the failure" });

    expect(res.ok).toBe(false);
    const after = getIssueReport(report!.id)!;
    expect(after.status).toBe("draft");
    expect(after.error).toBe("gh: not signed in");
    // Connect GitHub, press the same button: the wording is still theirs.
    expect(after.title).toBe("Edited before the failure");
  });

  it("refuses a dismissed report", async () => {
    const task = session("Dismissed");
    const { report } = await draft(task.id);
    dismissIssueReport(report!.id);

    const res = await submitIssueReport(report!.id, {});
    expect(res.ok).toBe(false);
    expect(createIssueMock).not.toHaveBeenCalled();
  });
});

describe("dismissIssueReport", () => {
  it("drops a draft and leaves a settled report alone", async () => {
    const task = session("Drop");
    const { report } = await draft(task.id);
    expect(dismissIssueReport(report!.id)!.status).toBe("dismissed");

    const filed = await draft(task.id);
    createIssueMock.mockResolvedValue({ ok: true, number: 9, url: "https://github.com/o/r/issues/9" });
    await submitIssueReport(filed.report!.id, {});
    // Not a way to un-file something that is already public.
    expect(dismissIssueReport(filed.report!.id)!.status).toBe("filed");

    expect(dismissIssueReport("nope")).toBeNull();
  });
});

describe("the routes the card talks to", () => {
  const req = (url: string, body?: unknown) =>
    new NextRequest(`http://127.0.0.1:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

  it("drafts through the bridge endpoint and settles onto the call", async () => {
    const task = session("Bridge");
    const call = reportCall(task.id, "calandria__report_issue");

    const res = await reportIssueEp(
      req("/api/internal/agent-tools/report-issue", {
        projectId: task.project_id,
        taskId: task.id,
        kind: "feature",
        title: "Let me pin a task",
        body: "It would help to keep one task at the top.",
      })
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: string };

    // The card is on the row the call produced, which is the point of the feature.
    expect(readData(task.id, call.id).issueReport).toEqual({ id: out.id });
    expect(getIssueReport(out.id)!.kind).toBe("feature");
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("serves the card, and 404s one that never existed", async () => {
    const task = session("Read");
    const { report } = await draft(task.id);

    const ok = await cardGet(new NextRequest("http://127.0.0.1:3000/x"), { params: Promise.resolve({ id: report!.id }) });
    expect(ok.status).toBe(200);
    const card = (await ok.json()) as IssueReportCard;
    expect(card.status).toBe("draft");
    expect(card.matches).toEqual([]);

    const gone = await cardGet(new NextRequest("http://127.0.0.1:3000/x"), { params: Promise.resolve({ id: "nope" }) });
    expect(gone.status).toBe(404);
  });

  it("returns the card on a refused send so the UI can explain itself", async () => {
    const task = session("Refused");
    const { report } = await draft(task.id);
    createIssueMock.mockResolvedValue({ ok: false, error: "gh: not signed in" });

    const res = await submitEp(req("/x", {}), { params: Promise.resolve({ id: report!.id }) });
    expect(res.status).toBe(400);
    const out = (await res.json()) as { error: string; card: IssueReportCard };
    expect(out.error).toBe("gh: not signed in");
    expect(out.card.status).toBe("draft");
    expect(out.card.error).toBe("gh: not signed in");
  });
});
