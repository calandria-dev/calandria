# Security policy

Operator hands its user a full shell (the integrated terminal) and runs
coding agents with `bypassPermissions` in the projects you point it at. That
is the intended, documented trust model for a **single-user instance on your
own machine** — the app itself is not a sandbox.

Things we DO consider vulnerabilities:

- Reaching the app, the terminal (`/pty`), or the agent endpoints **without**
  passing the configured origin auth (Cloudflare Access mode) or the
  `SERVICE_TOKEN` gates.
- Cross-origin attacks against a default local instance (e.g. a malicious
  website driving `http://localhost:3000` from the browser — CSRF/DNS
  rebinding).
- Cross-origin attacks against an **authenticated** instance. Passing Cloudflare
  Access is not consent: the `CF_Authorization` cookie is `SameSite=None`, so a
  hostile page that can make a logged-in user's browser open `/pty` gets a valid
  assertion for free. Anything that drives a signed-in instance from another
  origin counts, `/pty` most of all.
- One project's task escaping its git worktree isolation in a way the UI does
  not surface.
- Secrets (tokens, API keys) leaking into transcripts, logs, or diffs beyond
  what the user pasted themselves.

## Reporting

Please report vulnerabilities privately via GitHub Security Advisories
("Report a vulnerability" on the repo) rather than a public issue. You should
get a response within a few days.
