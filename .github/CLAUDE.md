# CI and releases — agent policy

Local verification (typecheck/build/preflight) and CI verify different things. Push success ≠ CI success: CI has caught stale tests, Docker-only breakage, and arch-specific failures that local runs can't. Main once sat red for ~9 hours across 12 pushes because every agent verified locally and nobody watched Actions.

- **Watch every push to terminal state.** After pushing to main, poll `gh run list` (bounded — both workflows finish inside ~10 min) until the runs for your SHA conclude. A dispatch that ends before its CI concludes is unfinished work.
- **Red run: diagnose before rerunning.** Compare the failing step against the last green run on a sibling commit. Failure in an infra step your commit can't plausibly have caused (e.g. the buildx floor-check dying with exit 255 before producing output — a known arm64/registry transient) → `gh run rerun <id> --failed` once. Green on attempt 2 = flake; note it. Red again, or any failure in test/typecheck/build steps = real; fix it or revert your commit. Never rerun to make a real failure go away.
- **File issues for CI problems — you are empowered and expected to.** Broken workflow, recurring flake, misconfiguration, or a red main you can't fix in-session: file a GitHub issue (or append to the open CI issue) with the run URL and the failing step's output. Never leave main silently red.
- **The buildx/BuildKit version pinning in `publish-image.yml` is deliberate** (see its header comment). Harden around it; don't "upgrade it away".
- **Releases are proposed, not cut, by agents.** Versioning process: issue #12. Suggest a release (draft notes, comment on the issue) when main is green and the delta is meaningful; the user tags.
