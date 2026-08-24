// Document collaboration mode — the pure half.
//
// A markdown file the agent touched can be opened from the Changes tab in a
// Word-style review: the user edits the text directly and/or attaches
// comments to passages they selected in the rendered view, then sends the
// whole thing back to the agent as ONE message. This module builds that
// message (`buildCollabPacket`). Pure — no fs, no DB, no SDK — because the
// CLIENT builds the packet (the modal sends it through the same runTurn path
// chat uses, so local running state stays in sync); the worktree read guard
// that needs fs lives in lib/worktreeFile.ts.

import { createTwoFilesPatch } from "diff";

// A passage comment as the client submits it. `quote` is the rendered text the
// user selected — rendered, not source, because the selection happens in the
// react-markdown view, so it carries no `**`/`#`/link syntax. `heading` is the
// nearest heading above the selection in the rendered DOM, a coarse anchor
// that survives when the quote can't be found in the source at all.
export interface PassageComment {
  quote: string;
  comment: string;
  heading?: string | null;
}

// How the user's edits reach the file. "direct": the modal has already
// written `edited` into the worktree (POST /api/tasks/[id]/file) and the diff
// in the packet is context only. "patch": the agent is asked to apply the
// diff itself, which keeps its session the only writer of the worktree — at
// the cost of trusting a model to apply a patch verbatim.
export type CollabEditMode = "direct" | "patch";
export const DEFAULT_COLLAB_EDIT_MODE: CollabEditMode = "direct";

export interface CollabSubmission {
  file: string;
  original: string; // the file as the modal loaded it
  edited: string; //   the file after the user's edits (=== original when untouched)
  comments: PassageComment[];
  general: string; // the free-form box under the comment list
  mode?: CollabEditMode; // defaults to "patch" — the packet is only ever told "direct" by a caller that has written the file
}

export const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdx", ".mdown", ".mkd"]);

export function isMarkdownPath(p: string): boolean {
  const dot = p.lastIndexOf(".");
  return dot >= 0 && MARKDOWN_EXTS.has(p.slice(dot).toLowerCase());
}

// Whitespace-insensitive, markdown-syntax-insensitive plain text, so a quote
// lifted from the RENDERED view can be matched against SOURCE lines.
function plain(s: string): string {
  return s
    .replace(/```[^\n]*/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]+/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Find the 1-based source line range containing a rendered quote. Exact
// substring match on the raw source first (cheap, precise for code and plain
// prose); then a sliding window over plain-ified lines for text the renderer
// reshaped. Null when neither finds it — the packet then falls back to the
// heading the client recorded.
export function locateQuote(source: string, quote: string): { lineStart: number; lineEnd: number } | null {
  const lines = source.split("\n");
  const q = quote.trim();
  if (!q) return null;
  const idx = source.indexOf(q);
  if (idx >= 0) {
    const lineStart = source.slice(0, idx).split("\n").length;
    const lineEnd = lineStart + q.split("\n").length - 1;
    return { lineStart, lineEnd };
  }
  const target = plain(q);
  if (!target) return null;
  // One plain-text stream over the non-empty lines with a start offset per
  // line, so a quote that crosses a soft line break still matches as prose.
  const starts: { line: number; at: number }[] = [];
  let joined = "";
  lines.forEach((l, i) => {
    const p = plain(l);
    if (!p) return;
    if (joined) joined += " ";
    starts.push({ line: i, at: joined.length });
    joined += p;
  });
  const at = joined.indexOf(target);
  if (at < 0) return null;
  const lineOf = (off: number) => {
    let line = starts[0].line;
    for (const s of starts) {
      if (s.at <= off) line = s.line;
      else break;
    }
    return line + 1;
  };
  return { lineStart: lineOf(at), lineEnd: lineOf(at + target.length - 1) };
}

// The unified diff of the user's edits, or "" when the text is unchanged.
export function collabPatch(file: string, original: string, edited: string): string {
  if (original === edited) return "";
  const patch = createTwoFilesPatch(`a/${file}`, `b/${file}`, original, edited, undefined, undefined, { context: 3 });
  // jsdiff prefixes an `Index:`/`====` banner that `git apply` and `patch`
  // tolerate but nobody needs; the agent reads this, so keep it to the diff.
  return patch.split("\n").filter((l, i) => !(i < 2 && (l.startsWith("Index:") || l.startsWith("===")))).join("\n");
}

function quoteBlock(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

// Compose the message the agent receives. Line numbers refer to the EDITED
// text, since that's what the comment view rendered and what the agent holds
// once it applies the patch (or, in direct mode, what is already on disk).
// Returns null when there is nothing to send.
export function buildCollabPacket(s: CollabSubmission): string | null {
  const patch = collabPatch(s.file, s.original, s.edited);
  const comments = s.comments.filter((c) => c.comment.trim() && c.quote.trim());
  const general = s.general.trim();
  if (!patch && comments.length === 0 && !general) return null;
  const direct = s.mode === "direct";

  const out: string[] = [];
  out.push(`Document review of \`${s.file}\` — I read it in collaboration mode and have feedback.`);
  out.push("");

  if (patch) {
    out.push("## My edits");
    out.push(
      direct
        ? `I edited \`${s.file}\` directly in the worktree — the file on disk already has these changes, so re-read it before touching it and do NOT apply this diff again. It's here so you can see what changed; the wording is final, don't rephrase it.`
        : "I edited the document directly. Apply this patch to the file exactly as written — the wording is final, don't rephrase it — before working on the comments below."
    );
    out.push("");
    out.push("```diff");
    out.push(patch.trimEnd());
    out.push("```");
    out.push("");
  }

  if (comments.length) {
    out.push("## Comments on passages");
    out.push(patch && !direct ? "Line numbers refer to the file AFTER my patch is applied." : "Line numbers refer to the current file.");
    out.push("");
    comments.forEach((c, i) => {
      const loc = locateQuote(s.edited, c.quote);
      const where = loc
        ? loc.lineStart === loc.lineEnd
          ? `line ${loc.lineStart}`
          : `lines ${loc.lineStart}–${loc.lineEnd}`
        : "location not found in source";
      const under = c.heading?.trim() ? `, under "${c.heading.trim()}"` : "";
      out.push(`${i + 1}. **${where}${under}:**`);
      out.push(quoteBlock(c.quote));
      out.push("");
      out.push(`   ${c.comment.trim().replace(/\n/g, "\n   ")}`);
      out.push("");
    });
  }

  if (general) {
    out.push("## General comments");
    out.push(general);
    out.push("");
  }

  out.push("Work through this on the document, then summarize what you changed.");
  return out.join("\n");
}
