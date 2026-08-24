# Document collaboration mode

When an agent writes or edits a markdown file, its section in the Changes tab
carries a **Collaborate** button. It opens the file as a document — not hunk by
hunk — so you can work on it the way you'd proofread in a word processor:

- **Edit** — a markdown source editor beside a live render. Your wording is sent
  to the agent as a unified diff, so untouched lines never change.
- **Comment** — the rendered document. Select a passage and press **Add
  comment** to attach a note to it; a **General comments** box takes feedback
  that isn't tied to any passage. Commented passages stay tinted while the
  modal is open, and clicking a comment scrolls to its passage.

Both tabs work on the same document state, so you can edit *and* comment in one
pass. **Send to agent** composes one message (`lib/collab.ts`,
`buildCollabPacket`) and sends it through the ordinary chat path, so it queues
behind a running turn like any other message. **Cancel** discards everything
(after a confirmation when there's unsent work).

What the agent receives:

```
Document review of `docs/setup.md` — I read it in collaboration mode and have feedback.

## My edits
I edited the document directly. Apply this patch to the file exactly as written — …

```diff
--- a/docs/setup.md
+++ b/docs/setup.md
@@ -8,3 +8,5 @@
 …
+Restart the server after changing either value.
```

## Comments on passages
Line numbers refer to the file AFTER my patch is applied.

1. **line 7, under "Configuration":**
> Set PORT to the port you want

   Say what the default port is.

## General comments
Too terse for a first-time reader overall.

Work through this on the document, then summarize what you changed.
```

A passage comment carries the selected text as rendered (no `**`/`#`/link
syntax — the selection happens in the rendered view), the nearest heading above
it, and the source line range `locateQuote()` finds for it — first as a verbatim
substring of the source, then by a markdown-syntax-insensitive match that
tolerates emphasis, code spans, list markers, links and soft line breaks. When
neither finds it, the packet says so and the heading is the anchor.

## Why a source editor, not a WYSIWYG one

The spike surveyed the widely used editors (August 2026): MDXEditor, Milkdown,
TipTap (+ `@tiptap/markdown`), Lexical (`@lexical/markdown`), Plate
(`@platejs/markdown` + `@platejs/comment`), BlockNote, Remirror, Toast UI,
`@uiw/react-md-editor`, and CodeMirror 6 — plus the annotation libraries
(Recogito, Annotorious, `web-highlighter`, `rangy`, `react-text-annotate`).

Every rich editor works by parsing markdown into its own document model and
**re-serializing on save**, which rewrites list markers, table padding, heading
styles and blank lines the user never touched. BlockNote's API is literally
named `blocksToMarkdownLossy`; MDXEditor and TipTap have open issues about
normalization. What leaves this modal is a *diff sent to an agent*, so that
noise would be read as instructions. CodeMirror edits the literal text, which
makes "untouched lines come back byte-identical" true by construction — and
the rendered view sits beside it, so the document still reads as a document.

On comments: TipTap's Comments extension is Tiptap Cloud Pro (paid). BlockNote's
requires a Yjs `ThreadStore` even for one user. Plate's `@platejs/comment` is
the one standalone, mark-based option and would be the pick if a single-library
WYSIWYG were ever wanted — with the round-trip caveat above. For a
select-and-annotate flow over an already-rendered document, the native
`Selection`/`Range` API plus the CSS Custom Highlight API (`CSS.highlights`,
Chrome 105+ / Safari 17.2+ / Firefox 140+) does the job with no dependency and
no DOM mutation under react-markdown; browsers without it still get the comment
list, just not the tint. `web-highlighter` was the fallback candidate and wasn't
needed.

Dependencies added: `diff` (jsdiff, the unified patch), `@uiw/react-codemirror`,
`@codemirror/lang-markdown`, `@codemirror/language-data` — CodeMirror is loaded
through `next/dynamic` so it stays out of the main bundle until a document is
opened.

## What the spike does not do (yet)

- Comments aren't persisted — they live in the modal until sent or cancelled,
  unlike line comments in the Changes tab (`task_comments`), which are stored
  and versioned against the diff head.
- The user's edits go to the agent as a patch to apply rather than being
  written to the worktree directly. Writing them straight to the file would be
  a small change (the read route's twin) if the patch step proves unreliable.
- The rendered view can't tell two identical passages apart: a quote is
  re-found by text search, so a selection inside the second of two identical
  sentences highlights the first. Rare in prose; the line number in the packet
  is computed the same way.
- Only markdown files get the button (`isMarkdownPath`); nothing stops the
  same modal from opening any text file, the render tab would just be less
  useful.
