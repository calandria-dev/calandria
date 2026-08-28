# docs/ — two rules

These files are rendered at <https://calandria.dev/docs> by `website/`, which reads
them where they live. Both rules are enforced by the site build in PR CI
(`.github/workflows/website.yml`), so breaking one fails the PR that broke it.

1. **Every `docs/*.md` starts with a `title` in front-matter.** Three lines,
   matching the H1 below it. Starlight requires it; the site build errors without
   it. GitHub renders it as a small table and otherwise ignores it. Subdirectories
   (`design/`, `superpowers/`) are internal, aren't published, and need nothing.
2. **Links stay relative and GitHub-correct.** `SELF_HOSTING.md#metrics`,
   `images/board.png`, `../.env.example` — write them so they work when someone
   reads the file on GitHub. A remark plugin in `website/` re-points them for the
   site (siblings become `/docs/<slug>/`, anything outside `docs/` becomes a
   github.com link). A link to a renamed file or a moved heading fails the build.
