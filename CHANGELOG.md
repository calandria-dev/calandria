# Changelog

Calandria began as a fork of [Operator](https://github.com/iishyfishyy/operator-oss)
by [@iishyfishyy](https://github.com/iishyfishyy), under the Apache License 2.0.
Releases up to and including 0.2.0 were cut while this repository was still a
GitHub fork of that project; 0.3.0 is the first release after the divergence —
detached from the upstream fork network, with the codebase renamed end to end.
Upstream's copyright and license are retained in [NOTICE](NOTICE) and credited
in README's "Name and lineage" section; this changelog only covers Calandria.

## [0.5.2](https://github.com/calandria-dev/calandria/compare/v0.5.1...v0.5.2) (2026-08-31)


### Bug Fixes

* **desktop:** hand electron-builder a signing qualifier, not a certificate name ([#87](https://github.com/calandria-dev/calandria/issues/87)) ([96f38c5](https://github.com/calandria-dev/calandria/commit/96f38c5fff471f4c49e4e178ffe6caa30bf22673))

## [0.5.1](https://github.com/calandria-dev/calandria/compare/v0.5.0...v0.5.1) (2026-08-30)


### Bug Fixes

* **ci:** stop the desktop lanes publishing, and asking for a token they have no business holding ([#84](https://github.com/calandria-dev/calandria/issues/84)) ([15ce022](https://github.com/calandria-dev/calandria/commit/15ce022a577bd6830b8734f999d95bec78978261))

## [0.5.0](https://github.com/calandria-dev/calandria/compare/v0.4.1...v0.5.0) (2026-08-30)


### Features

* **ci:** publish signed desktop artifacts on a release tag ([#77](https://github.com/calandria-dev/calandria/issues/77)) ([e216a90](https://github.com/calandria-dev/calandria/commit/e216a90a294080925c24cae83510c5b72a56eb98))
* **desktop:** a Windows packaging target, unsigned ([#71](https://github.com/calandria-dev/calandria/issues/71)) ([d67a756](https://github.com/calandria-dev/calandria/commit/d67a756733b8767ae0f2b662d722f0c4b749cec0))
* **desktop:** an Electron shell with a supervisor, packaging and four CI lanes ([#54](https://github.com/calandria-dev/calandria/issues/54)) ([1e8770b](https://github.com/calandria-dev/calandria/commit/1e8770bf5960658b5cbcb363c471625cab57cbec))
* **desktop:** auto-update through the drain, never around it ([#79](https://github.com/calandria-dev/calandria/issues/79)) ([2aacc05](https://github.com/calandria-dev/calandria/commit/2aacc057b0893c72d6c89cac529c45cc7b939c30))
* **desktop:** build macOS dmg and zip, and sign before they are cut ([#72](https://github.com/calandria-dev/calandria/issues/72)) ([f182301](https://github.com/calandria-dev/calandria/commit/f1823013592b1dc6dceebbdd2fc97829876ff67b))
* **desktop:** env-driven Developer ID signing and notarization ([#76](https://github.com/calandria-dev/calandria/issues/76)) ([f9d95fa](https://github.com/calandria-dev/calandria/commit/f9d95fad074d46dcf0fd559948873afdf56d72aa))
* **ui:** render the unstarted task's brief as markdown, and stop truncating the box under it ([#83](https://github.com/calandria-dev/calandria/issues/83)) ([33ca3fb](https://github.com/calandria-dev/calandria/commit/33ca3fb565927ec35a9e584d5117aa4930e42b2f))


### Bug Fixes

* collapse the session header's control rail to fit the pane ([#80](https://github.com/calandria-dev/calandria/issues/80)) ([6ea0283](https://github.com/calandria-dev/calandria/commit/6ea02834159473be9b73caa45b6cba0faf60a6d1))
* don't offer a finished task as a blocker, and sort the pickers A→Z ([#81](https://github.com/calandria-dev/calandria/issues/81)) ([539ed39](https://github.com/calandria-dev/calandria/commit/539ed39366e1fb292f65ac43e990af194629086c))

## [0.4.1](https://github.com/calandria-dev/calandria/compare/v0.4.0...v0.4.1) (2026-08-29)


### Bug Fixes

* **ci:** stop the release PR's post-merge label from cancelling main's Test run ([#68](https://github.com/calandria-dev/calandria/issues/68)) ([e216f21](https://github.com/calandria-dev/calandria/commit/e216f2186f17535fce1ddc06537c70ee589430b5)), closes [#48](https://github.com/calandria-dev/calandria/issues/48)

## [0.4.0](https://github.com/calandria-dev/calandria/compare/v0.3.0...v0.4.0) (2026-08-29)


### Features

* A cc/codex compatible skill for analyzing a calandria project and suggesting changes to support worktree development (calandria task qEYs7gB2pGrbLpRbcw1Wq) ([2f0ae01](https://github.com/calandria-dev/calandria/commit/2f0ae01be4ad3aa6e62d3badf92437e2ce0c8772))
* land work by pull request — PR state, create_pr, squash-merge, reclaim and red-build inbox ([#63](https://github.com/calandria-dev/calandria/issues/63)) ([d08146d](https://github.com/calandria-dev/calandria/commit/d08146d675c9af4af3af37e2a508f559206bca45))
* Let an agent suggest a task in-window, and offer the option to start that task directly. (calandria task Go_M3t7wSGLjeFTImRY31) ([3bcb135](https://github.com/calandria-dev/calandria/commit/3bcb1356ab2c8e97736af0ea973189289198d565))
* Let an agent suggest a task in-window, and offer the option to start that task directly. (calandria task Go_M3t7wSGLjeFTImRY31) ([669fea0](https://github.com/calandria-dev/calandria/commit/669fea0a45051c10224e6035467077d6a779d9b3))
* Move the delegation rule into the session prompt, where it fires ([#56](https://github.com/calandria-dev/calandria/issues/56)) ([7c45436](https://github.com/calandria-dev/calandria/commit/7c454366e2457a4e76ef74911fc1dcf39fc7da06))
* ship a worktree-readiness skill for Claude Code and Codex ([bdaba0a](https://github.com/calandria-dev/calandria/commit/bdaba0af31c53374f15cf4c61034aa5325cd1e23))
* **website:** calandria.dev placeholder + Cloudflare Pages deploy ([3a5bdb6](https://github.com/calandria-dev/calandria/commit/3a5bdb629fb856da51efe594d0e8ee0cbb46477a))
* **website:** create the calandria-dev Pages project, attach the domains, harden TLS ([e894bae](https://github.com/calandria-dev/calandria/commit/e894baee424767a9df08c4523ab905ca778c5d49))


### Bug Fixes

* npm ci compiles better-sqlite3 despite gypfile:false (main is red) (calandria task 4aJN-clk-dIiQs0nIyerr) ([0162c61](https://github.com/calandria-dev/calandria/commit/0162c6176197d233f3b97b9ba8e74bdc59a1d413))
* npm ci compiles better-sqlite3 despite gypfile:false (main is red) (calandria task 4aJN-clk-dIiQs0nIyerr) ([59a9dc3](https://github.com/calandria-dev/calandria/commit/59a9dc32dc9bcaa7082bc8b2b9d18a3243958edc))
* **tests:** close the backup fixture's SQLite handle from teardown ([#64](https://github.com/calandria-dev/calandria/issues/64)) ([a4cebba](https://github.com/calandria-dev/calandria/commit/a4cebbac669212b27e306e99e0fb783d82719d88))
* **ui:** shed a side column on a narrow window, not the transcript ([#66](https://github.com/calandria-dev/calandria/issues/66)) ([7b09dc4](https://github.com/calandria-dev/calandria/commit/7b09dc44bdfe40c0d30e5a25a8daf3d61ac0da81))

## [0.3.0](https://github.com/calandria-dev/calandria/compare/v0.2.0...v0.3.0) (2026-08-27)


### ⚠ BREAKING CHANGES

* ORCH_* env vars, the `orchestrator` MCP server name (the mcp__orchestrator__* tools), `orch/<id>` task branches, /home/orch and the ORCH_* compose variables are replaced by their CALANDRIA / calandria spellings. Old env names are honored as deprecated aliases and pre-rename on-disk state (~/.zen-orchestrator/orchestrator.db, ~/.agent-orchestrator/worktrees, orch/ branches) is found in place — but anything the user wrote against the old names, such as a ~/.claude allow rule on mcp__orchestrator__* or a compose override naming /home/orch or ORCH_USER, needs the new spelling. Upgrading needs no data migration.

### Features

* **agents:** update_task can edit any task, and the user sees what changed ([bb6f4a6](https://github.com/calandria-dev/calandria/commit/bb6f4a6ee43c31630a606c24723cc4af6d34eca4))
* rename the product surface from Operator/orchestrator to Calandria ([bb6f4a6](https://github.com/calandria-dev/calandria/commit/bb6f4a6ee43c31630a606c24723cc4af6d34eca4))
* **storage:** default instance state to ~/.calandria, with a pre-rename fallback ([bb6f4a6](https://github.com/calandria-dev/calandria/commit/bb6f4a6ee43c31630a606c24723cc4af6d34eca4))


### Bug Fixes

* **agent-edits:** refuse a Revert that would overwrite a later change; ack per row ([903b2da](https://github.com/calandria-dev/calandria/commit/903b2daad9dfc93389ad6bc6555e5b91416f628f))
* **autoStart:** declare a RunContext for dependency-triggered launches ([be0a345](https://github.com/calandria-dev/calandria/commit/be0a3457da503e5c7f32e3caf1a67dc71c0b24a2)), closes [#37](https://github.com/calandria-dev/calandria/issues/37)
* **board:** hold task_edited while this tab's drop is in flight ([b07eb1b](https://github.com/calandria-dev/calandria/commit/b07eb1b1efa566c013e2bc1b60f2da5fec6843b0)), closes [#35](https://github.com/calandria-dev/calandria/issues/35)
* **ci:** hand the notify job a token so it can actually file an issue ([b86ce31](https://github.com/calandria-dev/calandria/commit/b86ce31c695cc64eb2066709c16d6e397a16da19)), closes [#26](https://github.com/calandria-dev/calandria/issues/26)
* **ci:** make the release gate wait for test.yml instead of racing it ([41adba4](https://github.com/calandria-dev/calandria/commit/41adba41e7cc91f19bb057805b7ad79f0bc0db5f))
* **gauge:** size an unknown model id by the narrowest window, not the widest ([d4032cf](https://github.com/calandria-dev/calandria/commit/d4032cffea9b827ecddf872655a453c864c3ff67)), closes [#39](https://github.com/calandria-dev/calandria/issues/39)
* **git:** key the fetch cooldown on repo identity and branch, not the raw path ([dbd854d](https://github.com/calandria-dev/calandria/commit/dbd854d74d810625790ab5fb30e118b9ce5f9a64)), closes [#41](https://github.com/calandria-dev/calandria/issues/41)
* **git:** reattach a pruned pre-rename task to its orch/ branch, not a fresh calandria/ one ([fe2b0a2](https://github.com/calandria-dev/calandria/commit/fe2b0a2aa6d3167667a88048f605c15f80643555))
* **git:** surface a rejected push's hook output instead of the generic line ([0a993c9](https://github.com/calandria-dev/calandria/commit/0a993c9eb01fe833f7c6b013909d3be25277bfaa)), closes [#45](https://github.com/calandria-dev/calandria/issues/45)
* **scripts:** make the npm scripts run from a Windows shell ([bb6f4a6](https://github.com/calandria-dev/calandria/commit/bb6f4a6ee43c31630a606c24723cc4af6d34eca4))
* **start:** ship cross-env and concurrently as runtime dependencies ([5acb043](https://github.com/calandria-dev/calandria/commit/5acb04384afa2bb7536908feb65d2afdd684377d)), closes [#32](https://github.com/calandria-dev/calandria/issues/32)
* **tests:** pin CALANDRIA_PROJECTS_DIR so the unit suite never writes ~/projects ([550e90f](https://github.com/calandria-dev/calandria/commit/550e90fa7f94e50e0685e18c26707c04a997d195)), closes [#34](https://github.com/calandria-dev/calandria/issues/34)
* **tests:** stop the plan-usage overlay test expiring on a calendar date ([96ba9cc](https://github.com/calandria-dev/calandria/commit/96ba9cc0d5512182fc85d4addaa10a78138eb6c9)), closes [#31](https://github.com/calandria-dev/calandria/issues/31)
* **tests:** treat the generated CHANGELOG as frozen history in the naming guard ([a40ee80](https://github.com/calandria-dev/calandria/commit/a40ee80704805a4b0e3f9fde627eb7f1ed583000))

## [0.2.0](https://github.com/calandria-dev/calandria/compare/v0.1.0...v0.2.0) (2026-08-25)


### ⚠ BREAKING CHANGES

* remove upstream control-plane interop code

### Features

* **board:** card footers — worktree branch, diff stats, sparkline ([#10](https://github.com/calandria-dev/calandria/issues/10)) ([ed34488](https://github.com/calandria-dev/calandria/commit/ed344887c448148a002f99b24ecaa9533a076e44))
* **diffs:** unified/split toggle + review comments ([#10](https://github.com/calandria-dev/calandria/issues/10)) ([ce432fc](https://github.com/calandria-dev/calandria/commit/ce432fc2d545b7aba0b01acc3bfe8d0d67418644))
* **mobile:** bottom tab bar IA — board, diffs, terminals, insights ([#10](https://github.com/calandria-dev/calandria/issues/10)) ([3ad8481](https://github.com/calandria-dev/calandria/commit/3ad8481dbe57723933d91a5ecb07e13326213d63))
* Notifications (orchestrator task c5RKDR_deS46SWrmYceBc) ([d669278](https://github.com/calandria-dev/calandria/commit/d66927806328349760843b66e21bac247f31a05b))
* **privacy:** remove PostHog telemetry ([f3ff635](https://github.com/calandria-dev/calandria/commit/f3ff6351a00ba15b148af852c1e83c969c767f1f)), closes [#19](https://github.com/calandria-dev/calandria/issues/19)
* Queue task to auto start at usage window reset (orchestrator task P6VoygVH4XXS07px4mn9v) ([faeb1e7](https://github.com/calandria-dev/calandria/commit/faeb1e799521813a292d6b7551aa8b6aedff0673))
* **release:** add release-please, tag-triggered publish gate, latest/edge split ([8d83cc0](https://github.com/calandria-dev/calandria/commit/8d83cc0a2ee052d49250d0b0bdc9c1872bff5d2b))
* remove upstream control-plane interop code ([965f3c7](https://github.com/calandria-dev/calandria/commit/965f3c796b0994e2c413210a729937e5dd90de6d)), closes [#20](https://github.com/calandria-dev/calandria/issues/20)
* Runbooks (orchestrator task 3nyWB2XIvbjYToDqZBw8a) ([14e7354](https://github.com/calandria-dev/calandria/commit/14e73540668c52bdb54b475ccd6cbf8ed499c88b))
* Runbooks (orchestrator task 3nyWB2XIvbjYToDqZBw8a) ([5fa87f2](https://github.com/calandria-dev/calandria/commit/5fa87f26d4a66022afde57ca503fb94c4e21382b))
* **shutdown:** drain in-flight turns on SIGTERM/SIGINT (issue [#14](https://github.com/calandria-dev/calandria/issues/14) item 1) ([7f18986](https://github.com/calandria-dev/calandria/commit/7f1898619bfa76563ec0341edceab139e96b5d2a))


### Bug Fixes

* **config:** validate numeric env vars at boot instead of failing deep ([4766797](https://github.com/calandria-dev/calandria/commit/4766797d61cf678b506fbd49aaa40875c1a9a715))
* **db:** set busy_timeout so concurrent readers stall instead of erroring ([09002b4](https://github.com/calandria-dev/calandria/commit/09002b4f8031a84865df5287ae109f0f6ba48636))
* **diffs:** no-newline marker handling + side-qualified, versioned comment anchors ([#10](https://github.com/calandria-dev/calandria/issues/10)) ([0816ab6](https://github.com/calandria-dev/calandria/commit/0816ab68613b33fabd4421916eee7e26c90735ff))
* **docker:** bump bundled npm to patch vendored tar/brace-expansion CVEs ([04f50c8](https://github.com/calandria-dev/calandria/commit/04f50c828386a4d450f6d62c4ef0f2b7d08eeaec)), closes [#21](https://github.com/calandria-dev/calandria/issues/21)
* **docker:** pin gh apt package to defeat layer-cache staleness ([341c180](https://github.com/calandria-dev/calandria/commit/341c18085ac3f329295cd548302184e17bb0a465)), closes [#21](https://github.com/calandria-dev/calandria/issues/21)
* **fonts-test:** drop dotAll regex flag unsupported by ES2017 target ([a6854fa](https://github.com/calandria-dev/calandria/commit/a6854fabcfa2c351e3e42b4657c13accad0dd25e))
* **github:** resolve the gh binary beyond the server's PATH (ORCH_GH_BIN + install-dir probe) ([4810f47](https://github.com/calandria-dev/calandria/commit/4810f472d9f409c1e8cddeac1c2d6c8d4e11c199))
* **mobile:** clear floating button from tab bar ([#10](https://github.com/calandria-dev/calandria/issues/10)) ([6d26e80](https://github.com/calandria-dev/calandria/commit/6d26e80a55a21eee6ce625a5cfe53a0d250cad22))
* **mobile:** More-collapsed chat rail, flex titlebar, wider blur clearance, themed canvas ([4f2b105](https://github.com/calandria-dev/calandria/commit/4f2b105503fa46b10e2639bed744d0629110ef95))
* **mobile:** one-tap cards, send keeps the keyboard, taller titlebar, themed keyboard, more blur clearance ([24b8e69](https://github.com/calandria-dev/calandria/commit/24b8e69a8731f43cdb52faadda419aa097f46211))
* **mobile:** restore composer autocorrect; stop the needs-you pill squishing ([777f8ea](https://github.com/calandria-dev/calandria/commit/777f8ea95d870c2dd39544e973dac49134bbdd1e))
* **mobile:** return = newline, centered input line, keyboard-aware tab bar, reliable needs-you jump, reordered chat rail ([d48450a](https://github.com/calandria-dev/calandria/commit/d48450a39a23539d9923ae1a571fa72f56f0b21d))
* **mobile:** six touch/PWA papercuts — tap targets, layout wrap, iOS quirks ([8063304](https://github.com/calandria-dev/calandria/commit/8063304824831a373ec9d4d686abe6ef8236c562))
* nav-trap on mobile tabs, fail-closed diff stats, env-driven metadataBase, cache/token cleanups ([0ec09bb](https://github.com/calandria-dev/calandria/commit/0ec09bb404a41c10f2b7d6057fa0baf8f82656f6))
* **notifications:** stop blaming the user for a browser policy block ([fc3ca35](https://github.com/calandria-dev/calandria/commit/fc3ca35a46fb73b24d6b1520c00e52d267cdd29a))
* **release:** cut plain `vX.Y.Z` tags so publish-image.yml actually fires ([eaf256e](https://github.com/calandria-dev/calandria/commit/eaf256ec0f2b1e7d29d183d211a2cedd0b7ac0a7))
* **release:** run release-please in manifest mode so 0.x config applies ([a1052b2](https://github.com/calandria-dev/calandria/commit/a1052b2a1cc8d2d265fea45eee344c710b9ef1ca))
* resolve merge conflicts and add verifyClient to pty-server.js ([90ad5ec](https://github.com/calandria-dev/calandria/commit/90ad5ec6ea31dba469e75d67547e649789398238))
* secure local browser origin boundary ([a9068d1](https://github.com/calandria-dev/calandria/commit/a9068d12e429f0266dd24419ff393a0044dd93ef))
* **security:** scope .trivyignore to genuinely upstream-blocked CVEs ([cce8efe](https://github.com/calandria-dev/calandria/commit/cce8efe2dbc561402b430c7fb8ea44c9903862fb)), closes [#21](https://github.com/calandria-dev/calandria/issues/21)
* **ui:** hide the task agent picker when only one agent is connected ([a3b4ea4](https://github.com/calandria-dev/calandria/commit/a3b4ea42e702bab000cebb4e0e05f0d308587920))
* **ui:** revamp bug roundup — full-width task cards, wrapping titles, font-picker focus box, modal heading face ([fb6a603](https://github.com/calandria-dev/calandria/commit/fb6a603266178a74d33049414c59195068fdf260))
* **ui:** roundup follow-ups — badge to the foot, pill ↔ snooze swap, real font-picker fix, body-face field labels ([19ec965](https://github.com/calandria-dev/calandria/commit/19ec96539267ee55082e817ee73185ac5a32faa2))
