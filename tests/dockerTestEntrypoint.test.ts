import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { expect } from "vitest";
import { killChildTree, onLinux } from "./platform";

const ENTRYPOINT = path.resolve("docker/test/entrypoint.sh");

function identity(cwd: string, imageId: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(path.join(cwd, "package.json")));
  hash.update(fs.readFileSync(path.join(cwd, "package-lock.json")));
  hash.update(imageId);
  return hash.digest("hex");
}

function waitForFile(file: string, child?: ChildProcess, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(file)) return resolve();
      if (child?.exitCode !== null && child?.exitCode !== undefined) {
        return reject(new Error(`child exited before creating ${file}: ${child.exitCode}`));
      }
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${file}`));
      setTimeout(check, 20);
    };
    check();
  });
}

function run(cwd: string, env: Partial<NodeJS.ProcessEnv>): ChildProcess {
  return spawn("bash", [ENTRYPOINT, "bash", "-c", `touch "$ENTERED"; deadline=$((SECONDS + 5)); while [ ! -e "$RELEASE" ]; do [ "$SECONDS" -lt "$deadline" ] || exit 88; sleep 0.02; done`], {
    cwd,
    env: { ...process.env, ...env },
    stdio: "ignore",
    detached: true,
  });
}

function finished(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode ?? 1);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function fixture(root: string, name: string, sharedModules?: string): string {
  const cwd = path.join(root, name);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name }));
  fs.writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify({ name }));
  if (sharedModules) fs.symlinkSync(sharedModules, path.join(cwd, "node_modules"), "dir");
  else fs.mkdirSync(path.join(cwd, "node_modules"));
  return cwd;
}

function installStub(root: string): { bin: string; log: string } {
  const bin = path.join(root, "bin");
  const log = path.join(root, "install.log");
  const realFlock = spawnSync("which", ["flock"], { encoding: "utf8" }).stdout.trim();
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "flock"), `#!/bin/bash
set -euo pipefail
touch "$FLOCK_ATTEMPT"
if [ "$1" = -x ] && [ -n "\${FLOCK_EXCLUSIVE_ATTEMPT:-}" ]; then touch "$FLOCK_EXCLUSIVE_ATTEMPT"; fi
exec "${realFlock}" "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$PWD" >> "$INSTALL_LOG"
sleep 0.2
printf 'installed\\n' > node_modules/dependency-sentinel
if [ -n "\${FAIL_ONCE:-}" ] && [ ! -e "$FAIL_ONCE" ]; then touch "$FAIL_ONCE"; exit 1; fi
`, { mode: 0o755 });
  return { bin, log };
}

onLinux("docker test entrypoint serializes installs and permits shared suites", async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".docker-test-entrypoint-"));
  const modules = path.join(root, "volume");
  fs.mkdirSync(modules);
  const first = fixture(root, "first", modules);
  const second = fixture(root, "second", modules);
  fs.copyFileSync(path.join(first, "package.json"), path.join(second, "package.json"));
  fs.copyFileSync(path.join(first, "package-lock.json"), path.join(second, "package-lock.json"));
  const npm = installStub(root);
  const release = path.join(root, "release");
  const common = {
    PATH: `${npm.bin}:${process.env.PATH ?? ""}`,
    INSTALL_LOG: npm.log,
    CALANDRIA_TEST_IMAGE_ID: "sha256:test-image",
    CALANDRIA_TEST_CACHE_ID: "",
  };
  const a = run(first, { ...common, FLOCK_ATTEMPT: path.join(root, "a-flock"), ENTERED: path.join(root, "a-entered"), RELEASE: release });
  const b = run(second, { ...common, FLOCK_ATTEMPT: path.join(root, "b-flock"), ENTERED: path.join(root, "b-entered"), RELEASE: release });
  try {
    await Promise.all([waitForFile(path.join(root, "a-entered"), a), waitForFile(path.join(root, "b-entered"), b)]);
    fs.writeFileSync(release, "go");
    expect(await Promise.all([finished(a), finished(b)])).toEqual([0, 0]);
    expect(fs.readFileSync(npm.log, "utf8").trim().split("\n")).toHaveLength(1);
    expect(fs.readFileSync(path.join(modules, ".docker-test-cache-id"), "utf8").trim())
      .toBe(identity(first, "sha256:test-image"));
  } finally {
    killChildTree(a);
    killChildTree(b);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

onLinux("docker test entrypoint waits for readers before changing a shared volume", async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".docker-test-switch-"));
  const modules = path.join(root, "volume");
  fs.mkdirSync(modules);
  const first = fixture(root, "reader", modules);
  const second = fixture(root, "writer", modules);
  const npm = installStub(root);
  const firstImage = "sha256:first";
  const firstWant = identity(first, firstImage);
  fs.writeFileSync(path.join(modules, ".docker-test-cache-id"), `${firstWant}\n`);
  fs.writeFileSync(path.join(modules, "dependency-sentinel"), "reader-deps\n");
  const common = {
    PATH: `${npm.bin}:${process.env.PATH ?? ""}`,
    INSTALL_LOG: npm.log,
    CALANDRIA_TEST_CACHE_ID: "",
  };
  const releaseReader = path.join(root, "release-reader");
  const releaseWriter = path.join(root, "release-writer");
  const reader = run(first, {
    ...common,
    CALANDRIA_TEST_IMAGE_ID: firstImage,
    CALANDRIA_TEST_CACHE_ID: firstWant,
    FLOCK_ATTEMPT: path.join(root, "reader-flock"),
    ENTERED: path.join(root, "reader-entered"),
    RELEASE: releaseReader,
  });
  let writer: ChildProcess | undefined;
  try {
    await waitForFile(path.join(root, "reader-entered"), reader);
    writer = run(second, {
      ...common,
      CALANDRIA_TEST_IMAGE_ID: "sha256:second",
      CALANDRIA_TEST_CACHE_ID: identity(second, "sha256:second"),
      FLOCK_ATTEMPT: path.join(root, "writer-flock"),
      FLOCK_EXCLUSIVE_ATTEMPT: path.join(root, "writer-exclusive"),
      ENTERED: path.join(root, "writer-entered"),
      RELEASE: releaseWriter,
    });
    await waitForFile(path.join(root, "writer-exclusive"), writer);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fs.existsSync(npm.log)).toBe(false);
    expect(fs.readFileSync(path.join(modules, "dependency-sentinel"), "utf8")).toBe("reader-deps\n");
    fs.writeFileSync(releaseReader, "go");
    expect(await finished(reader)).toBe(0);
    await waitForFile(npm.log, writer);
    await waitForFile(path.join(modules, "dependency-sentinel"), writer);
    expect(fs.readFileSync(path.join(modules, "dependency-sentinel"), "utf8")).toBe("installed\n");
    await waitForFile(path.join(root, "writer-entered"), writer);
    fs.writeFileSync(releaseWriter, "go");
    expect(await finished(writer)).toBe(0);
    expect(fs.readFileSync(npm.log, "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    killChildTree(reader);
    killChildTree(writer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

onLinux("docker test entrypoint leaves failed installs unstamped and retries", async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".docker-test-retry-"));
  const cwd = fixture(root, "retry");
  const npm = installStub(root);
  const failOnce = path.join(root, "failed-once");
  const env = {
    ...process.env,
    PATH: `${npm.bin}:${process.env.PATH ?? ""}`,
    INSTALL_LOG: npm.log,
    FAIL_ONCE: failOnce,
    CALANDRIA_TEST_IMAGE_ID: "sha256:retry-image",
    CALANDRIA_TEST_CACHE_ID: "",
    FLOCK_ATTEMPT: path.join(root, "retry-flock"),
  };
  try {
    const failed = spawn("bash", [ENTRYPOINT, "true"], { cwd, env, stdio: "ignore", detached: true });
    expect(await finished(failed)).toBe(1);
    expect(fs.existsSync(path.join(cwd, "node_modules", ".docker-test-cache-id"))).toBe(false);
    const recovered = spawn("bash", [ENTRYPOINT, "true"], { cwd, env, stdio: "ignore", detached: true });
    expect(await finished(recovered)).toBe(0);
    expect(fs.readFileSync(path.join(cwd, "node_modules", ".docker-test-cache-id"), "utf8").trim())
      .toBe(identity(cwd, "sha256:retry-image"));
    expect(fs.readFileSync(npm.log, "utf8").trim().split("\n")).toHaveLength(2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

onLinux("docker test entrypoint rejects a checkout changed after cache selection", async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".docker-test-changed-"));
  const cwd = fixture(root, "changed");
  const npm = installStub(root);
  try {
    const child = spawn("bash", [ENTRYPOINT, "true"], {
      cwd,
      env: {
        ...process.env,
        PATH: `${npm.bin}:${process.env.PATH ?? ""}`,
        INSTALL_LOG: npm.log,
        CALANDRIA_TEST_IMAGE_ID: "sha256:changed-image",
        CALANDRIA_TEST_CACHE_ID: "wrong-checkout-identity",
      },
      stdio: "ignore",
      detached: true,
    });
    expect(await finished(child)).toBe(75);
    expect(fs.existsSync(npm.log)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
