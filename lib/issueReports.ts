/**
 * `report_issue` — the agent noticing that the user just reported a bug in
 * Calandria, or wished for a feature, and offering to send it upstream.
 *
 * THE TOOL CALL FILES NOTHING. It drafts: it writes a row, asks GitHub whether
 * an issue already covers this, and puts a card in the transcript. The only
 * thing that leaves the machine at draft time is a READ (the duplicate search).
 * Publishing to a public tracker is outward-facing and irreversible-ish, so the
 * consent is a click on the card — which is also where the user edits the text,
 * because the words that become a public issue should be theirs, not a model's
 * paraphrase of them that they only got to approve wholesale.
 *
 * That split is why the model is told the card IS the asking: an agent that
 * asked "shall I file this?" in prose and then called the tool would be
 * collecting consent twice, and an agent that treated the tool call itself as
 * the filing would be collecting it never.
 *
 * Two rules protect the public artifact:
 *  - Only a `draft` may be submitted. A settled report is inert, so a stale tab
 *    or a second click on a card that already filed cannot open a duplicate.
 *  - Submission is single-flight per report (`filing` below). The draft check
 *    alone is not enough: the status write happens AFTER `gh` returns, so two
 *    clicks landing inside one round trip would both pass it.
 *
 * A failed submit records the reason and leaves the report a draft, so the
 * user's report is never lost to a dead `gh` — they can connect GitHub and
 * press the same button again.
 *
 * SDK-free (store + github + config) and pinned by tests/importGraph.test.ts:
 * reached from the internal agent-tools route, a sync-compiled route entry.
 */

import { ISSUE_REPO } from "@/lib/config";
import { commentOnIssue, createIssue, searchIssues } from "@/lib/github";
import { createIssueReport, getIssueReport, updateIssueReport } from "@/lib/store";
import type { IssueMatch, IssueReport, IssueReportCard, Task } from "@/lib/types";

export const ISSUE_KINDS = ["bug", "feature"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/** GitHub's own title limit is 256; leave room rather than have gh truncate. */
const MAX_TITLE = 200;
/** Generous, but an agent pasting a whole transcript into an issue helps nobody. */
const MAX_BODY = 60_000;
/** How many possible duplicates to put in front of the user. Past a handful it reads as noise. */
const MAX_MATCHES = 5;

/** The repository reports are filed into; "" when the instance has turned the tool off. */
export function issueRepo(): string {
  return ISSUE_REPO.trim();
}

export function issueReportsEnabled(): boolean {
  return issueRepo() !== "";
}

export function isIssueKind(v: unknown): v is IssueKind {
  return typeof v === "string" && (ISSUE_KINDS as readonly string[]).includes(v);
}

/**
 * Reports currently talking to GitHub. In memory, not a column: it exists to
 * collapse a double-click inside one round trip, and a flag that survived a
 * crash would wedge the report as unsubmittable forever.
 */
const filing = new Set<string>();

function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function parseMatches(raw: string): IssueMatch[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as IssueMatch[]) : [];
  } catch {
    return [];
  }
}

/** The shape the transcript card renders; see lib/issueReportCard.ts on why it re-reads. */
export function issueReportCard(id: string): IssueReportCard | null {
  const r = getIssueReport(id);
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    repo: r.repo,
    title: r.title,
    body: r.body,
    status: r.status,
    issue_number: r.issue_number,
    issue_url: r.issue_url,
    error: r.error,
    matches: parseMatches(r.matches),
  };
}

/**
 * Draft a report and hunt for issues that already cover it.
 *
 * The search is BEST-EFFORT by contract, exactly as `fetchBase` is: a missing
 * or signed-out `gh` must not cost the user their report. The reason is kept on
 * the row so the card can say why the duplicate list is empty and why File will
 * fail, instead of the user discovering both by pressing the button.
 */
export async function draftIssueReport(
  task: Task,
  input: { kind?: string; title?: string; body?: string }
): Promise<{ report: IssueReport | null; text: string }> {
  const repo = issueRepo();
  if (!repo) {
    return { report: null, text: "Issue reporting is turned off on this instance (CALANDRIA_ISSUE_REPO). Relay the report to the user in your reply instead." };
  }
  const title = clamp(input.title ?? "", MAX_TITLE);
  if (!title) return { report: null, text: "A title is required." };
  const kind: IssueKind = isIssueKind(input.kind) ? input.kind : "bug";
  const body = clamp(input.body ?? "", MAX_BODY);

  const found = await searchIssues(repo, title, MAX_MATCHES);
  const matches = found.ok ? found.issues : [];

  const report = createIssueReport({
    task_id: task.id,
    project_id: task.project_id,
    kind,
    repo,
    title,
    body,
    matches: JSON.stringify(matches),
    error: found.ok ? "" : found.error,
  });

  const dupes = matches.length
    ? ` ${matches.length} existing issue${matches.length === 1 ? "" : "s"} may already cover it (${matches.map((m) => `#${m.number}`).join(", ")}), and the card offers to add to any of them instead.`
    : "";
  const trouble = found.ok ? "" : ` The duplicate search failed (${found.error}), so the card lists none.`;
  return {
    report,
    text:
      `Drafted a ${kind === "bug" ? "bug report" : "feature request"} for ${repo}: "${title}". ` +
      `NOTHING HAS BEEN FILED — a card in the transcript lets the user edit the title and body and choose to open a new issue or add to an existing one.${dupes}${trouble} ` +
      `Tell them the card is there and let them decide; don't ask for permission again in prose, and don't try to file it yourself.`,
  };
}

/**
 * File the report, or append it to `issueNumber`. `title`/`body` are the user's
 * edits from the card and are saved whether or not GitHub accepts them.
 */
export async function submitIssueReport(
  id: string,
  input: { title?: string; body?: string; issueNumber?: number | null }
): Promise<{ ok: boolean; report: IssueReport | null; error?: string }> {
  const existing = getIssueReport(id);
  if (!existing) return { ok: false, report: null, error: "That report no longer exists." };
  if (existing.status !== "draft") {
    return { ok: false, report: existing, error: `This report was already ${existing.status === "dismissed" ? "dismissed" : "sent"}.` };
  }
  if (filing.has(id)) return { ok: false, report: existing, error: "That report is already being sent." };

  const title = clamp(input.title ?? existing.title, MAX_TITLE);
  if (!title) return { ok: false, report: existing, error: "A title is required." };
  const body = clamp(input.body ?? existing.body, MAX_BODY);
  const number = typeof input.issueNumber === "number" && Number.isFinite(input.issueNumber) ? input.issueNumber : null;

  // Persist the edits before the network call, so a failure leaves the user's
  // wording on the row rather than the model's.
  updateIssueReport(id, { title, body, error: "" });

  filing.add(id);
  try {
    const res = number
      ? await commentOnIssue({ repo: existing.repo, number, body: commentBody(existing.kind, title, body) })
      : await createIssue({ repo: existing.repo, title, body });
    if (!res.ok) {
      return { ok: false, report: updateIssueReport(id, { error: res.error }), error: res.error };
    }
    return {
      ok: true,
      report: updateIssueReport(id, {
        status: number ? "commented" : "filed",
        issue_number: res.number,
        issue_url: res.url,
        error: "",
      }),
    };
  } finally {
    filing.delete(id);
  }
}

/**
 * A comment on someone else's issue needs to say what it is; a bare paste of a
 * report body reads as a non-sequitur under an unrelated title.
 */
function commentBody(kind: string, title: string, body: string): string {
  const lead = kind === "feature" ? "Also wanted" : "Also hit this";
  return `**${lead}: ${title}**\n\n${body}`;
}

/** Drop the draft. Hard delete is the house style, but the transcript row points here. */
export function dismissIssueReport(id: string): IssueReport | null {
  const r = getIssueReport(id);
  if (!r) return null;
  if (r.status !== "draft") return r;
  return updateIssueReport(id, { status: "dismissed", error: "" });
}
