# Contributing

Thanks for your interest in Operator!

Questions and feature ideas belong in
[GitHub Discussions](https://github.com/iishyfishyy/operator-oss/discussions). Reproducible
bugs belong in [Issues](https://github.com/iishyfishyy/operator-oss/issues). For the full
map, see the [community guide](docs/COMMUNITY.md).

## Getting started

```bash
npm install
npm run dev       # app on :3000, pty sidecar on 127.0.0.1:3001
npm run typecheck # next typegen + tsc --noEmit; seconds, and CI runs exactly this
npm test          # vitest — serial on purpose; tests spawn real git subprocesses
npm run test:e2e
npm run preflight # unit + end-to-end suite; the pre-push gate
```

`CLAUDE.md` is the codebase map (architecture, conventions, gotchas) — read it before a
nontrivial change. TypeScript is strict and there is no lint script, so `npm run typecheck`
is the only static check there is. (`next typegen` writes the gitignored `next-env.d.ts`
and `.next/types` that `tsconfig.json` includes, so a fresh clone checks the same files
`next build` does.)

Every one of those has a `:docker` twin (`npm run test:docker`, `typecheck:docker`,
`test:e2e:docker`, `preflight:docker`) that runs it in a throwaway Linux container with
its own `node_modules` volume and matching Playwright browsers — the way to get a green
run out of a checkout whose dependencies were installed on another platform. If you work
with an agent that reads Claude Code skills, `.claude/skills/running-tests/` encodes the
same workflow.

The end-to-end suite builds the production app and drives onboarding, project/task
creation, turns, diff, merge, and workspace views against a disposable instance. It uses
the deterministic mock agent, so no agent CLI or login is required. See
[`e2e/README.md`](e2e/README.md) — which also documents the container harness.

## Continuous integration

`.github/workflows/test.yml` runs `npm run typecheck` and `npm test` on every pull request
and every push to `main`, as two independent jobs, and the image publish gates on both — a
red suite never reaches the registry.

The e2e suite is much slower, so it does **not** run on every push. It runs on `main`, and
on a pull request labelled `e2e` — add that label when a change touches the core flow
(onboarding, turns, diff, merge) and you want the browser-level proof before merge.

## Before starting

- Search existing issues and discussions first.
- For nontrivial features, open an Ideas discussion and agree on scope before investing in
  an implementation.
- Comment on an existing issue before claiming it. Issues labelled `good first issue` or
  `help wanted` are intended for community contributions.

## Ground rules

- **One change per PR**, with a commit message that explains the *why*, not just the what.
- **Tests:** bug fixes come with a regression test; behavior changes update the affected
  tests. `npm test` must be green.
- **Documentation stays current:** if you change user-visible behavior, update `README.md`
  or the relevant file under `docs/` in the same PR.
- **Env-driven config:** a new per-instance knob is an env var with a documented default,
  added to `lib/config.ts` (or `lib/features.ts` for flags) **and** `.env.example`.

## AI-assisted contributions

AI-written code is welcome. Contributors remain responsible for understanding the change,
testing it, and addressing review feedback.

Every pull request must include a short **Human-written context** section written in the
contributor's own words, without AI generating or rewriting it. It must explain:

- the bug, limitation, or user need being addressed; and
- the proposed fix at a high level, including why that approach was chosen.

Clearly label any AI-generated text elsewhere in the pull request description or review
discussion as **AI-generated details**. You do not need to label individual lines of
AI-written code. The goal is to give reviewers an authentic explanation from the person
submitting and standing behind the change, while keeping AI-assisted implementation fully
welcome.

## Developer Certificate of Origin

Contributions are accepted under the [Developer Certificate of
Origin](https://developercertificate.org/). By adding a `Signed-off-by` line to your commits
(`git commit -s`), you certify that you have the right to submit the work under this
repository's Apache-2.0 license.

## Conduct

Be respectful, constructive, and assume good intent. Critique ideas and code, not people.
Report security problems privately as described in [SECURITY.md](SECURITY.md).
