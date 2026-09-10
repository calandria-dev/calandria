---
title: "Document collaboration mode"
---

# Document collaboration mode

Collaboration mode opens a file the agent wrote as a whole document instead of
a diff. You proofread it, edit the text, attach comments to the passages you
want changed, and send the whole review to the agent as one message.

Use it for the work where the wording is the point: a README, a design note, a
runbook, release notes. For code, the Changes tab and its hunks are still the
faster read.

## Open a document

There are three ways in, and they see different files.

1. **From the Changes tab.** Select the task, open the **DIFF** tab in the
   session rail, and press **Collaborate** on a file's row.
2. **From the transcript.** Press **Collaborate** on a **Write** or **Edit**
   tool card. This one appears the moment the write lands, so you do not have
   to switch tabs, and it reaches files the diff never lists, such as notes the
   agent keeps under a gitignored `scratch/` directory.
3. **From a link.** Click a markdown link that names a file in the checkout,
   in a message, in the task description, or inside an open document. The
   link may be relative (`docs/guide.md`), absolute under the worktree or the
   project's repo, a `file:` URL, or a citation with a line number
   (`lib/a.ts:42`). A text file opens here; an image opens in a new tab, and
   an archive or other binary downloads. A web link opens as usual.

Either way the file opens in a **Collaborate on document** window with two
tabs, **EDIT** and **COMMENT**. Both tabs share one copy of the document, so
you can edit and comment in a single pass. Nothing here is modal-only: edits,
the general note, and passage comments autosave and are still there if you
close the window and reopen it.

### When there is no button

| Case | Why |
|-|-|
| The agent has not touched the file | The button hangs off a change or a tool call. There is no file picker, and you cannot create a new file here. |
| The file is binary | Only text opens. |
| The file was deleted in this task | There is nothing to read. |
| The tool call failed | The transcript offers the button only on a call that succeeded. |
| The file is over 1 MB | Opening it reports `file too large for collaboration mode (max 1024 KB)`. |

## Edit the text

The **EDIT** tab gives you the file's source. Markdown opens with a live
render beside the editor. Any other text file opens with the editor alone,
with syntax highlighting picked from the filename.

You edit the literal text, so lines you do not touch come back byte for byte
as they were.

Once you change something, an **Edits** picker appears in the footer. It sets
how your edits reach the file when you press Send, and your choice is
remembered in that browser.

| Option | What Send does |
|-|-|
| **Write to file** (default) | Writes your edited text into the task's worktree, then sends the message. The message carries the diff so the agent can see what moved, and tells it the file on disk already has the changes and must not be patched again. |
| **Send as patch for the agent to apply** | Writes nothing. The message carries a unified diff and tells the agent to apply it exactly as written. Only the agent's own session touches the worktree. |

Prefer **Write to file** when you want the wording you typed to be the wording
on disk. A model asked to apply a patch verbatim sometimes rephrases it.

Two things change that:

- **A turn is running.** The option reads **Write to file (agent is working)**
  and is disabled. The agent owns the worktree until its turn ends, so your
  edits go as a patch. Pick **Write to file** again once the turn finishes.
- **The file changed since you opened it.** The write is refused and you are
  told `file changed since it was loaded`. Your edits were made against text
  that is no longer on disk, so send them as a patch for the agent to
  reconcile, or cancel and reopen the document. Nothing is merged for you.

## Comment on a passage

The **COMMENT** tab shows the rendered document, with a comment panel down the
right.

1. Select the passage you want to talk about. A **+ Add comment** button
   appears next to the selection.
2. Press it, type what should change, and press **Add**. `Cmd`/`Ctrl` + `Enter`
   does the same thing.
3. For feedback that belongs to no single passage, use the **General
   comments** box at the foot of the panel.

Commented passages stay tinted while the window is open. Click a comment card
to scroll its passage into view. Remove a comment you have not sent yet with
the **×** on its card.

A card tagged **not found** means its passage is no longer in the current text,
usually because you edited over it. The comment still sends, and the agent is
told the location could not be found.

## Send it to the agent

**Send to agent** composes one message and sends it down the ordinary chat
path, so it queues behind a running turn like anything else you type.

What the agent gets is your review, not the whole file over again:

- **Each comment arrives with the context it needs.** The passage you selected
  is quoted as you saw it rendered, so it carries no `**`, `#` or link syntax.
  With it go the nearest heading above the passage and the line, or line
  range, where it sits in the source. Comments are numbered in the order the
  panel shows them.
- **Your edits arrive once**, as a unified diff of the whole file, with a
  sentence saying the wording is final and should not be rephrased.
- **The general note arrives last**, under its own heading.

A section is left out entirely when it is empty. Comments with no edits send
as comments alone.

The agent reads the passage locations off the source: an exact text match
first, then a match that ignores emphasis, code spans, list markers, links and
soft line breaks. When neither finds the passage, the message says so and
falls back to the heading as the anchor.

A review with one edit and one comment reaches the agent looking like this:

````
Document review of `docs/setup.md` — I read it in collaboration mode and have feedback.

## My edits
I edited the document directly. Apply this patch to the file exactly as written — the wording is final, don't rephrase it — before working on the comments below.

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
````

In **Write to file** mode the edits preamble instead says the file on disk
already has the changes and the diff must not be applied again, and the line
numbers refer to the current file.

## Diagrams

A ```` ```mermaid ```` fence renders as a diagram in both tabs, so an agent's
design doc reads as a design doc. You can comment on a node label the same way
you comment on any other text.

While you type in the **EDIT** tab, the render follows the source after a
short pause. When the source does not parse, the last diagram that did stays
on screen, dimmed, with the parser's message underneath.

The transcript keeps showing a mermaid fence as code.

Diagrams render under mermaid's `strict` security level and the drawn SVG is
sanitized before it reaches the page, because the source is whatever the agent
or you wrote. Diagrams follow the app theme.

## What is saved

| Item | Saved |
|-|-|
| Passage comments | Immediately, as you add them. They survive a reload, and they survive the Changes tab remounting when you collapse the rail or switch tabs. |
| Text edits | Autosaved about 600ms after you stop typing, as one draft per file. Restored when you reopen the document, if the file has not changed since. |
| General comments box | Autosaved the same way as text edits, and always restored when you reopen the document. |
| Edits picker choice | In your browser, across documents and sessions. |

Each comment is stamped with the file's content as it stood when you opened
it. That means:

- Comments folded into a Send become read only and stay listed under **Sent to
  agent**.
- Once the file moves past the version they were written against, they collapse
  into a **Show N outdated comments** group instead of being shown against text
  they were not written for.
- Comments you have not sent stay live no matter what the file does. Every Send
  folds in whatever is still open, so you decide each time whether they still
  apply.

An unsent comment can also be edited: the pencil button on its card reopens it
in the compose box, and **Save** rewrites it in place
(`PATCH /api/tasks/[id]/doc-comments/[cid]` with `{ body }`). A sent comment
stays read-only; the server refuses editing one the same way it refuses
deleting one, with a 409. Selecting a different passage while a comment is
still open saves it first instead of dropping it, then opens a fresh compose
box against the new selection; if that save fails, the box stays open with
the error shown.

Text edits and the general note autosave too, as one draft row per (task,
file) in `task_doc_drafts` (`/api/tasks/[id]/doc-draft`), about 600ms after
you stop typing, and flush immediately when the window unmounts, whether
that's a rail collapse, a tab switch, Escape, or Cancel. The footer shows
**saving…**, then **saved**, or **not saved** with the error if a save fails.
Sending the message clears the draft. A **Discard edits** button in the
footer throws away the edit and the general note after a confirmation; it
leaves passage comments untouched.

The edit draft is anchored to the file's blob sha as it stood when you opened
it. The general note always comes back; the edited text only comes back if
the sha still matches. If the file changed since, the modal shows the current
file with a banner instead of silently patching the old edit onto the new
text. **Restore edits** puts your saved version back in the editor and diffs
it against the current file; **Discard them** drops the stale draft.

Closing the window (Cancel, Escape, the scrim, or a rail collapse) never
discards anything by itself. A confirmation appears only when something
would actually be lost: a comment still sitting in the compose box, or an
edit whose save just failed.

## Limits

- **No undo inside the app.** A **Write to file** lands straight in the task's
  worktree. The worktree is the task's own branch, so `git diff` in the task
  terminal shows the change and `git checkout -- <file>` reverts it.
- **The write happens first.** Choosing **Write to file** means Send writes the
  file before it composes the message. If the send then fails, the file on disk
  has already changed.
- **Sent comments cannot be taken back.** Send another comment instead.
- **Two identical passages cannot be told apart.** A passage is found again by
  searching the text, so selecting inside the second of two identical sentences
  points at the first. The line number in the message is found the same way.
- **One person at a time.** There is no live co-editing and no presence. Two
  people editing the same file get the `file changed since it was loaded`
  refusal, not a merge.
- **Files only, up to 1 MB**, and only files the agent has already written or
  changed.
