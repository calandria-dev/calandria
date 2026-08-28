---
title: "Document collaboration mode"
---

# Document collaboration mode

When an agent writes or edits a text file, a **Collaborate** button appears on
that file's row in the Changes tab and on the **Write**/**Edit** tool card in
the transcript.

The two buttons see different files. The Changes tab button follows the diff,
which lists tracked changes plus untracked files, minus anything gitignored:
notes the agent keeps under an ignored `scratch/` or `.local/` never show up
there. The tool card button is keyed on the path the agent actually wrote (the
runner stores it worktree-relative on the tool message, and only when it
resolves inside the task's worktree), so it opens the moment the Write lands,
and you don't need to switch to the diff tab to reach it.

Either way, `GET /api/tasks/[id]/file` reads the file. That route confines
reads to the worktree and doesn't check git status.

It opens the file as a whole document, letting you proofread it the way you
would in a word processor:

- **Edit**: a source editor beside a live render for markdown (a ```mermaid```
  fence renders as a diagram, see below), or the editor alone with syntax
  picked from the filename for any other text file. Untouched lines never
  change. How the edited ones reach the file is set by the **Edits** picker in
  the footer, which appears once you've changed something, and your choice
  persists per browser:
  - **Write to file** (default): Send writes the edited text straight into
    the task's worktree (`POST /api/tasks/[id]/file`, the read route's twin,
    under the same path guard). The message carries the diff for context
    only, telling the agent the file already has these changes. This is the
    reliable route, because a model asked to apply a patch verbatim sometimes
    doesn't. The server responds with a 409 in two cases: a turn is
    running, so the picker greys out the option and edits go as a patch until
    it ends; or the file changed since you opened it, because the agent's
    last turn or a terminal wrote to it. In that case your edits were made
    against text that no longer exists, so send them as a patch for the agent
    to reconcile, or cancel and reopen.
  - **Send as patch**: the message carries a unified diff the agent is told
    to apply exactly as written. Nothing but the agent's own session touches
    the worktree.
- **Comment**: the rendered document, or the verbatim text for a non-markdown
  file. Select a passage and press **Add comment** to attach a note to it. A
  **General comments** box takes feedback that isn't tied to any passage.
  Commented passages stay tinted while the modal is open, and clicking a
  comment scrolls to its passage.

Both tabs share the same document state, so you can edit and comment in one
pass. **Send to agent** composes one message (`lib/collab.ts`,
`buildCollabPacket`) and sends it through the ordinary chat path, so it queues
behind a running turn like any other message. **Cancel** discards your edits
and the general note, asking for confirmation if there are any. Passage
comments are already saved and remain when you reopen the document.

What the agent receives in patch mode (in direct mode the "My edits" preamble
says the file on disk already has the changes and the diff must not be
reapplied, and comment line numbers refer to the current file):

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

A passage comment carries the selected text as rendered (no `**`, `#`, or
link syntax, since the selection happens in the rendered view), the nearest
heading above it, and the source line range that `locateQuote()` finds for
it. It first tries a verbatim substring match against the source, then a
markdown-syntax-insensitive match that tolerates emphasis, code spans, list
markers, links, and soft line breaks. When neither match succeeds, the packet
says so and uses the heading as the anchor.

## Diagrams

A ```` ```mermaid ```` fence renders as the diagram it describes in both tabs
(`<Markdown diagrams>` → `app/Mermaid.tsx`), so an agent's design doc reads as
a design doc, and a passage comment can attach to a node label like any other
text.

The transcript keeps showing the fence as code, because a message re-renders
on every streamed token: a half-written diagram would fail to parse on each
one, while a document is read whole only after it finishes.

In the Edit tab, the render follows the source with a short debounce. When
the source doesn't parse, it keeps the **last good diagram** on screen,
dimmed, with the parser's message underneath, because a diagram being typed
is invalid more often than valid, and a picture that blinks out on every
keystroke isn't useful while you're typing.

Rendering runs with mermaid's `strict` security level (the SVG goes through
DOMPurify, since the source is whatever the agent or the user wrote) and
follows the app theme. `mermaid` loads on first use through a dynamic import,
so its ~2MB never reaches a session that opens no diagram.

## Comments are saved as you go

Passage comments persist the moment you add them, to `task_doc_comments` via
`/api/tasks/[id]/doc-comments`, so a review survives a reload or the Changes
tab remounting (which happens on every rail collapse and tab switch,
unmounting this modal).

Each comment is stamped with the file's git blob sha as it was loaded (the
file route's `sha`), not the worktree HEAD. An agent edits documents without
committing, so HEAD wouldn't reflect the change a review is actually about.

On Send, the drafts folded into the packet are marked sent: read-only from
then on, but still listed against the document under "Sent to agent". Once
the file's content moves past the sha they were written against, they
collapse into a "Show N outdated comment(s)" group instead of being matched
against text they weren't written for.

Drafts stay live regardless of their anchor. They can be removed, and each
Send folds in whatever is still open so you decide whether it still applies.
A draft is flagged "not found" if its passage isn't in the current text.

## Editor choice: source over WYSIWYG

The spike surveyed the widely used editors as of August 2026: MDXEditor,
Milkdown, TipTap (with `@tiptap/markdown`), Lexical (`@lexical/markdown`),
Plate (`@platejs/markdown` and `@platejs/comment`), BlockNote, Remirror,
Toast UI, `@uiw/react-md-editor`, and CodeMirror 6, plus the annotation
libraries Recogito, Annotorious, `web-highlighter`, `rangy`, and
`react-text-annotate`.

Every rich editor parses markdown into its own document model and
re-serializes on save, which rewrites list markers, table padding, heading
styles, and blank lines you never touched. BlockNote's API is literally named
`blocksToMarkdownLossy`, and MDXEditor and TipTap both have open issues about
normalization. What leaves this modal is a diff sent to an agent, so that
noise would be read as instructions.

CodeMirror edits the literal text, so untouched lines come back
byte-identical. The rendered view sits beside it, so the document still
reads as a document.

For comments: TipTap's Comments extension is Tiptap Cloud Pro (paid), and
BlockNote's requires a Yjs `ThreadStore` even for one user. Plate's
`@platejs/comment` is the one standalone, mark-based option, and would be the
pick if the app ever wanted a single-library WYSIWYG, subject to the
round-trip caveat above.

For a select-and-annotate flow over an already-rendered document, the native
`Selection`/`Range` API plus the CSS Custom Highlight API (`CSS.highlights`,
Chrome 105+, Safari 17.2+, Firefox 140+) does the job with no dependency and
no DOM mutation under react-markdown. Browsers without it still get the
comment list, just not the tint. `web-highlighter` was the fallback candidate
and wasn't needed.

Dependencies added: `diff` (jsdiff, for the unified patch),
`@uiw/react-codemirror`, `@codemirror/lang-markdown`, and
`@codemirror/language-data`. CodeMirror loads through `next/dynamic`, so it
stays out of the main bundle until a document is opened, and `mermaid` loads
the same lazy way on the first diagram.

## What the spike does not do (yet)

- Edits in the Edit tab and the General comments box are modal-only: closing
  discards them, after a confirmation.
- A direct write isn't versioned or undoable beyond what git offers. The
  worktree is the task's branch, so `git diff` in the task terminal shows the
  change and `git checkout -- <file>` reverts it, but there is no in-app
  undo.
- The rendered view can't tell two identical passages apart. A quote is
  found again by text search, so a selection inside the second of two
  identical sentences highlights the first. This is rare in prose; the line
  number in the packet is computed the same way.
- Only markdown files get the button (`isMarkdownPath`). The same modal can
  open any text file; the render tab is just less useful for one.
