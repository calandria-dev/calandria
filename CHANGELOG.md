# Changelog

Calandria began as a fork of [Operator](https://github.com/iishyfishyy/operator-oss)
by [@iishyfishyy](https://github.com/iishyfishyy), under the Apache License 2.0.
Releases up to and including 0.2.0 were cut while this repository was still a
GitHub fork of that project; 0.3.0 is the first release after the divergence —
detached from the upstream fork network, with the codebase renamed end to end.
Upstream's copyright and license are retained in [NOTICE](NOTICE) and credited
in README's "Name and lineage" section; this changelog only covers Calandria.

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
