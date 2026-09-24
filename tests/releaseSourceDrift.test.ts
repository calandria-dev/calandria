import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dockerCopyInventory,
  packagedInputDrift,
  releaseSourceDrift,
} from "../scripts/release-source-drift.mjs";

const DOCKERFILE = `FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY . .
RUN npm ci

FROM node:22-slim
ARG AGY_VERSION=1.2.9
ARG AGY_SHA512_AMD64=aaa
RUN set -eu; \\
    echo "\${AGY_VERSION}"
# COPY commented out stays out of the inventory
COPY --from=build --chown=root:root /app/.next ./.next
COPY --from=build --chown=root:root /app/server.js \\
     /app/pty-server.js ./
`;

describe("dockerCopyInventory", () => {
  it("joins continuations and ignores comments and other instructions", () => {
    expect(dockerCopyInventory(DOCKERFILE)).toEqual([
      "COPY package.json package-lock.json ./",
      "COPY . .",
      "COPY --from=build --chown=root:root /app/.next ./.next",
      "COPY --from=build --chown=root:root /app/server.js /app/pty-server.js ./",
    ]);
  });

  it("treats a COPY heredoc as the whole file", () => {
    const text = "FROM x\nCOPY <<EOF /etc/conf\nvalue\nEOF\n";
    expect(dockerCopyInventory(text)).toEqual(text.split("\n"));
  });
});

describe("packagedInputDrift", () => {
  const read = (from: string | null, to: string | null) => (side: "from" | "to") =>
    side === "from" ? from : to;

  it("drops a Dockerfile change that leaves COPY alone", () => {
    const bumped = DOCKERFILE.replace("AGY_VERSION=1.2.9", "AGY_VERSION=1.2.10").replace("=aaa", "=bbb");
    expect(packagedInputDrift(["Dockerfile"], read(DOCKERFILE, bumped))).toEqual([]);
  });

  it("keeps a Dockerfile change to the COPY inventory", () => {
    const moved = DOCKERFILE.replace("/app/pty-server.js ./", "/app/pty-server.js /app/extra.mjs ./");
    expect(packagedInputDrift(["Dockerfile"], read(DOCKERFILE, moved))).toEqual(["Dockerfile"]);
  });

  it("keeps a Dockerfile added or removed", () => {
    expect(packagedInputDrift(["Dockerfile"], read(null, DOCKERFILE))).toEqual(["Dockerfile"]);
    expect(packagedInputDrift(["Dockerfile"], read(DOCKERFILE, null))).toEqual(["Dockerfile"]);
  });

  it("keeps every other path", () => {
    expect(packagedInputDrift(["lib/x.ts", "docker/test/Dockerfile"], read(null, null))).toEqual([
      "lib/x.ts",
      "docker/test/Dockerfile",
    ]);
  });
});

describe("releaseSourceDrift", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function repo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-release-drift-"));
    roots.push(root);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: root,
        encoding: "utf8",
      }).trim();
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    const commit = () => {
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", "c");
      return git("rev-parse", "HEAD");
    };
    git("init", "-q");
    write("Dockerfile", DOCKERFILE);
    write("lib/app.ts", "export {};\n");
    return { root, write, commit, base: commit() };
  }

  it("reports only packaged-app inputs between two commits", () => {
    const r = repo();
    r.write("Dockerfile", DOCKERFILE.replace("AGY_VERSION=1.2.9", "AGY_VERSION=1.2.10"));
    r.write("tests/a.test.ts", "x\n");
    r.write(".github/workflows/x.yml", "x\n");
    r.write("CLAUDE.md", "x\n");
    const pinOnly = r.commit();
    expect(releaseSourceDrift(r.base, pinOnly, r.root)).toEqual([]);

    r.write("lib/app.ts", "export const x = 1;\n");
    r.write("Dockerfile", `${DOCKERFILE}COPY --from=build /app/new.mjs ./lib/\n`);
    const real = r.commit();
    expect(releaseSourceDrift(pinOnly, real, r.root).sort()).toEqual(["Dockerfile", "lib/app.ts"]);
  });
});
