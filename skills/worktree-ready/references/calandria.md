# What Calandria does to a worktree

Read this when the repo is run under Calandria. The advice in `SKILL.md` holds
for any such tool; these are the specifics that decide *which* fixes matter
most here.

Contents: [Worktree creation](#worktree-creation) · [What does not
happen](#what-does-not-happen) · [Ports and services](#ports-and-services) ·
[Project settings that help](#project-settings-that-help) · [Disk](#disk)

## Worktree creation

- One worktree per **task**, at `~/.calandria/worktrees/<task-id>`
  (`CALANDRIA_WORKTREES_DIR`), **outside** the project repo, so the
  workspace-root corruption problem in `ecosystems.md` doesn't apply.
- Branch `calandria/<task-id>`, created with `git worktree add -b`.
- Cut from the project's base branch resolved to a **pinned SHA**, or from the
  fetched remote tip when local base is merely behind it.
- The agent session's working directory is that worktree.

## What does not happen

This is the load-bearing part, and it's a short list because the answer is
"nothing":

- **No files are copied in.** Not `.env`, not `node_modules`, not local certs,
  not gitignored config. The worktree holds tracked files at one commit.
- **No setup or install runs.** There is no per-worktree bootstrap hook. The
  worktree is created and the first turn starts in it.
- **Submodules are not initialized.** `git worktree add` doesn't, and nothing
  else does either.

A project's `setup_command` in Managed Services looks like it would cover this
and doesn't: it is user-triggered from the Services drawer and runs against the
project's **main checkout**, not a task's worktree.

So the only mechanism that gets a fresh worktree ready is **the agent doing it
in its first turn**, which means the repo's instruction file has to say what to
run. That's why the bootstrap check in `SKILL.md` outranks everything except
missing files.

## Ports and services

Two different paths, and only one of them gets a port:

| Path | Working directory | `PORT` |
|-|-|-|
| Managed service (`dev`/`setup`/`test`, `expose_service`) | project's main checkout | injected, one per **project** |
| Agent runs a server itself in its worktree | the task's worktree | nothing injected |

Consequences to state in a report:

- There is **one port per project**, not per task. Two tasks cannot each run
  the project's `dev` service; the second gets a readable "port already in use"
  error.
- An agent that starts a server in its own worktree picks its own port. It can
  only pick one if the repo honors `PORT`; otherwise it's stuck on whatever
  literal is in the source, colliding with every sibling task.
- Once it has picked, `expose_service(name, port)` registers it and returns a
  URL. Registration is keyed by project and name, so two tasks exposing the
  same name overwrite each other. Have the agent use a name that includes the
  task.
- A dev server behind that URL sees a proxied hostname, so host checks need to
  allow it: `CALANDRIA_PUBLIC_HOST` is injected for services, and Vite
  (`server.allowedHosts`) or Next (`allowedDevOrigins`) should read it.

## Project settings that help

- **Project context**: the free-text "what we're building" field, sent into
  new task sessions. Put the bootstrap command in the repo's `CLAUDE.md` /
  `AGENTS.md` first, since that's version-controlled and reviewable, but
  naming it here too costs nothing and reaches sessions that don't load the
  repo file.
- **Base branch**: worktrees are cut from it, so a stale base means every task
  starts from stale code and every merge carries noise.
- **Agent**: Claude Code sessions read `CLAUDE.md` and the repo's
  `.claude/skills`; Codex sessions read `AGENTS.md` and `.agents/skills`. A
  project that might use either needs both files present.

## Disk

Every task's worktree is a full checkout and it **persists after the task
merges**. N tasks costs roughly N × the repo's checked-out size, indefinitely,
and per-worktree dependency installs land on top of that.

That's what makes install size a real finding rather than a nitpick: on a repo
where `npm install` is 500MB, twenty finished tasks are 10GB nobody has looked
at. It's also the argument for pnpm's global store in a repo that will see
heavy parallel use, since the saving is multiplied by every task ever run, not
just the ones running now.
