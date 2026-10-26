import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect } from "vitest";
import { onPosix } from "./platform";

function digest(...parts: (string | Buffer)[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

onPosix("docker-test keys its image and dependency volume by their inputs", () => {
  const fixture = fs.mkdtempSync(path.join(process.cwd(), ".docker-test-script-"));
  const shimDir = path.join(fixture, "bin");
  const shim = path.join(shimDir, "docker");
  const log = path.join(fixture, "calls.log");
  const scriptDir = path.join(fixture, "scripts");
  const dockerDir = path.join(fixture, "docker", "test");
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(dockerDir, { recursive: true });
  fs.copyFileSync("scripts/docker-test.sh", path.join(scriptDir, "docker-test.sh"));
  fs.copyFileSync("docker/test/Dockerfile", path.join(dockerDir, "Dockerfile"));
  fs.copyFileSync("docker/test/entrypoint.sh", path.join(dockerDir, "entrypoint.sh"));
  const packageJson = Buffer.from('{"name":"docker-test-fixture"}\n');
  const lockfile = (version: string) => Buffer.from(JSON.stringify({
    packages: { "node_modules/@playwright/test": { version } },
  }));
  fs.writeFileSync(path.join(fixture, "package.json"), packageJson);
  fs.writeFileSync(path.join(fixture, "package-lock.json"), lockfile("1.2.3"));
  fs.writeFileSync(
    shim,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$DOCKER_SHIM_LOG"
if [ "$1" = volume ] && [ "$2" = create ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  if [ "\${3:-}" = --format ]; then printf '%s\\n' "$DOCKER_IMAGE_ID"; fi
  exit 0
fi
if [ "$1" = build ] || [ "$1" = run ]; then exit 0; fi
exit 99
`,
    { mode: 0o755 },
  );

  const calls: string[] = [];
  const invoke = (imageId: string) => {
    fs.writeFileSync(log, "");
    const result = spawnSync("bash", ["scripts/docker-test.sh", "true"], {
      cwd: fixture,
      env: {
        ...process.env,
        CALANDRIA_TEST_VOLUME: "",
        CALANDRIA_TEST_REBUILD: "",
        DOCKER_IMAGE_ID: imageId,
        DOCKER_SHIM_LOG: log,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const output = fs.readFileSync(log, "utf8").trim().split("\n");
    calls.push(...output);
    return output.find((call) => call.startsWith("run "))!;
  };

  try {
    const idA = "sha256:image-a";
    const runA = invoke(idA);
    const runAAgain = invoke(idA);
    const runB = invoke("sha256:image-b");
    fs.writeFileSync(path.join(fixture, "package.json"), Buffer.from('{"name":"changed"}\n'));
    const runPackage = invoke(idA);
    fs.writeFileSync(path.join(fixture, "package-lock.json"), lockfile("4.5.6"));
    const runLock = invoke(idA);

    const cacheA = digest(packageJson, lockfile("1.2.3"), idA);
    const packageIdentity = digest(Buffer.from('{"name":"changed"}\n'), lockfile("1.2.3"), idA);
    const lockIdentity = digest(Buffer.from('{"name":"changed"}\n'), lockfile("4.5.6"), idA);
    expect(runA).toContain(`calandria-test-node-modules-${cacheA}:/work/node_modules`);
    expect(runA).toContain(`-e CALANDRIA_TEST_IMAGE_ID=${idA}`);
    expect(runA).toContain(`-e CALANDRIA_TEST_CACHE_ID=${cacheA}`);
    expect(runA).toContain(idA);
    expect(runAAgain).toBe(runA);
    expect(runB).not.toContain(`calandria-test-node-modules-${cacheA}:/work/node_modules`);
    expect(runPackage).not.toContain(`calandria-test-node-modules-${cacheA}:/work/node_modules`);
    expect(runLock).not.toContain(`calandria-test-node-modules-${cacheA}:/work/node_modules`);
    expect(runPackage).toContain(`calandria-test-node-modules-${packageIdentity}:/work/node_modules`);
    expect(runLock).toContain(`calandria-test-node-modules-${lockIdentity}:/work/node_modules`);
    expect(lockIdentity).not.toBe(packageIdentity);
    expect(calls.some((call) => call.includes("volume create --label com.calandria.cache=disposable"))).toBe(true);
    expect(calls.some((call) => call.includes(`calandria-test:base-pw4.5.6-${digest(fs.readFileSync(path.join(dockerDir, "Dockerfile")), fs.readFileSync(path.join(dockerDir, "entrypoint.sh")))}`))).toBe(true);

    fs.appendFileSync(path.join(dockerDir, "entrypoint.sh"), "\n# changed harness\n");
    invoke(idA);
    expect(calls.some((call) => call.includes(`calandria-test:base-pw4.5.6-${digest(fs.readFileSync(path.join(dockerDir, "Dockerfile")), fs.readFileSync(path.join(dockerDir, "entrypoint.sh")))}`))).toBe(true);

    fs.writeFileSync(log, "");
    const override = spawnSync("bash", ["scripts/docker-test.sh", "true"], {
      cwd: fixture,
      env: {
        ...process.env,
        CALANDRIA_TEST_VOLUME: "exact-override",
        CALANDRIA_TEST_REBUILD: "",
        DOCKER_IMAGE_ID: idA,
        DOCKER_SHIM_LOG: log,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });
    expect(override.status, override.stderr).toBe(0);
    expect(fs.readFileSync(log, "utf8")).toContain("-v exact-override:/work/node_modules");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
