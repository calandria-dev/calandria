# Document collaboration mode

When an agent writes or edits a text file, its section in the Changes tab
carries a **Collaborate** button, and so does the **Write**/**Edit** tool card in
the transcript. The two differ in what they can see: the Changes tab follows the
diff, which lists tracked changes plus untracked files *minus* anything
gitignored, so notes the agent keeps under an ignored `scratch/` or `.local/`
never appear there. The tool card is keyed on the path the agent actually wrote
(the runner stores it worktree-relative on the tool message, and only when it
resolves inside the task's worktree), so those files open the moment the Write
lands — and any document opens without switching to the diff. Either way the
file is read by `GET /api/tasks/[id]/file`, which confines reads to the worktree
and knows nothing about git status.

It opens the file as a document — not hunk by hunk — so you can work on it the
way you'd proofread in a word processor:

- **Edit** — a source editor beside a live render (markdown), or the editor
  alone with syntax picked from the filename (any other text file). Untouched
  lines never change; how the edited ones reach the file is the **Edits**
  picker in the footer (it appears once you've changed something, and the
  choice is remembered per browser):
  - **Write to file** (default) — Send writes the edited text straight into
    the task's worktree (`POST /api/tasks/[id]/file`, the read route's twin,
    under the same path guard) and the message carries the diff *for context
    only*, telling the agent the file already has these changes. This is the
    reliable route: a model asked to apply a patch verbatim sometimes doesn't.
    The server refuses it in two cases, both 409: **a turn is running** (the
    agent owns the worktree until it ends — the picker greys the option out
    and your edits go as a patch until then), and **the file changed since you
    opened it** (the agent's last turn or a terminal wrote it; your edits were
    made against text that is no longer there, so send them as a patch for
    the agent to reconcile, or cancel and reopen).
  - **Send as patch** — the message carries a unified diff the agent is told
    to apply exactly as written. Nothing touches the worktree but the agent's
    own session, which is the reason to pick it.
- **Comment** — the rendered document (the verbatim text, for a non-markdown
  file). Select a passage and press **Add comment** to attach a note to it; a
  **General comments** box takes feedback
  that isn't tied to any passage. Commented passages stay tinted while the
  modal is open, and clicking a comment scrolls to its passage.

Both tabs work on the same document state, so you can edit *and* comment in one
pass. **Send to agent** composes one message (`lib/collab.ts`,
`buildCollabPacket`) and sends it through the ordinary chat path, so it queues
behind a running turn like any other message. **Cancel** discards your edits
and the general note (after a confirmation when there are any); passage
comments are already saved and are there when you reopen the document.

What the agent receives (patch mode; in direct mode the "My edits" preamble
says the file on disk already has the changes and the diff must not be
re-applied, and comment line numbers refer to the current file):

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

## Comments are saved as you go

Passage comments persist the moment you add them — `task_doc_comments`, via
`/api/tasks/[id]/doc-comments` — so a review survives a reload or the Changes
tab remounting (it does that on every rail collapse and tab switch, which
unmounts this modal). Each comment is stamped with the *file's* git blob sha
as it was loaded (the file route's `sha`), not the worktree HEAD: an agent
edits documents without committing, so HEAD wouldn't see the change a review
is actually about. On Send, the drafts folded into the packet are marked sent
— read-only from then on, but still listed against the document, under "Sent
to agent" — and once the file's content moves on from the sha they were
written against, they collapse into a "Show N outdated comment(s)" group
rather than being guess-painted onto text they weren't written for. Drafts
stay live regardless of their anchor — removable, and folded into the next Send
(the user decides whether they still apply) — and are flagged "not found" if
their passage isn't in the current text.

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

- Edits in the Edit tab and the General comments box are still modal-only —
  closing discards them (after a confirmation).
- A direct write isn't versioned or undoable beyond what git offers: the
  worktree is the task's branch, so `git diff` in the task terminal shows it
  and `git checkout -- <file>` takes it back, but there is no in-app undo.
- The rendered view can't tell two identical passages apart: a quote is
  re-found by text search, so a selection inside the second of two identical
  sentences highlights the first. Rare in prose; the line number in the packet
  is computed the same way.
- Only markdown files get the button (`isMarkdownPath`); nothing stops the
  same modal from opening any text file, the render tab would just be less
  useful.
