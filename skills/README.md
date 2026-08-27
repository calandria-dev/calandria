# Skills shipped with Calandria

Agent skills you can install into your own environment or into a project you
run under Calandria. They are written to the [Agent Skills][spec] format, which
Claude Code and Codex both read, so one directory serves either agent.

| Skill | What it does |
|-|-|
| [`worktree-ready`](worktree-ready/) | Audits a repository for parallel git-worktree development — files a fresh checkout won't have, per-worktree install cost, hardcoded ports, shared databases, Compose collisions, tooling that assumes `.git` is a directory — and proposes the repo-side fixes. |

These are for *your* projects. The skill under `.claude/skills/` in this repo
(`running-tests`) is for people working on Calandria itself.

## Install

```bash
scripts/install-skills.sh              # both agents, all skills, user scope
scripts/install-skills.sh --list       # what's available
```

That copies each skill to `~/.claude/skills/<name>` and `~/.agents/skills/<name>`
— the two locations Claude Code and Codex scan. User scope means every project
you open gets the skill and nobody's repository grows a file they didn't ask
for.

To commit a skill into one repo instead, so the whole team and every task
session gets it:

```bash
scripts/install-skills.sh --project ~/projects/my-app worktree-ready
```

Other flags: `--agent claude|codex|both`, `--force` to replace an existing
copy, `--link` to symlink instead of copy (keeps the skill current with a `git
pull`, but symlinks don't survive a Windows checkout without Developer Mode,
which is why copying is the default).

Start a new session afterwards — agents scan their skill directories at
startup.

## Using one

Both agents pick a skill up from its description when the task matches, so
usually you just ask for what you want:

> This project is going to have five tasks running at once. Is it ready for
> that?

To invoke it by name: `/worktree-ready` in Claude Code, `$worktree-ready` in
Codex.

## Authoring

Keep to the six frontmatter fields in the [open spec][spec] — `name`,
`description`, `license`, `compatibility`, `metadata`, `allowed-tools`. Claude
Code accepts a longer list of its own, but anything beyond the six is ignored
by Codex and rejected outright by Claude's packaging and upload tooling, so a
skill that uses them stops being portable.

The rest of the shape:

- `name` must match the directory, lowercase and hyphenated.
- `description` is the only thing an agent sees until the skill fires, so it
  carries the triggers — what it does *and* when to reach for it, key case
  first. It's truncated, from the end.
- Keep `SKILL.md` itself short (under ~500 lines). Depth goes in
  `references/*.md`, read only when needed, one hop from `SKILL.md` — an agent
  may only preview a file reached through another file.
- `scripts/` is for work that must come out the same every time. Prose is for
  judgement calls.

[spec]: https://agentskills.io/specification
