import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect } from "vitest";
import { onPosix } from "./platform";

onPosix("docker-test labels a new cache before running with the same volume", () => {
  const fixture = fs.mkdtempSync(path.join(process.cwd(), ".docker-test-script-"));
  const shim = path.join(fixture, "docker");
  const log = path.join(fixture, "calls.log");
  const volume = "calandria-focused-test-cache";

  fs.writeFileSync(
    shim,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$DOCKER_SHIM_LOG"
if [ "\$1" = volume ] && [ "\$2" = create ]; then exit 0; fi
if [ "\$1" = image ] && [ "\$2" = inspect ]; then exit 0; fi
if [ "\$1" = run ]; then exit 0; fi
exit 99
`,
    { mode: 0o755 },
  );

  try {
    const result = spawnSync("bash", ["scripts/docker-test.sh", "true"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CALANDRIA_TEST_VOLUME: volume,
        DOCKER_SHIM_LOG: log,
        PATH: `${fixture}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    const create = calls.findIndex((call) =>
      call.includes(`volume create --label com.calandria.cache=disposable --name ${volume}`),
    );
    const run = calls.findIndex((call) => call.startsWith("run "));
    expect(create).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(create);
    expect(calls[run]).toContain(`-v ${volume}:/work/node_modules`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
