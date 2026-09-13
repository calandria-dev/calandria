// Local installation detection for the coding environments Calandria can run.
// This module stays SDK-free so routes can inspect the host without loading a
// driver. A config directory is also an installation signal when the server's
// PATH cannot see the binary.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isExecutableFile, resolveBin, spawnSpec } from "../binPath";
import type { EnvironmentId } from "../providers/types";

export interface AgentInstallation {
  installed: boolean;
  installedVersion: string | null;
}

export interface AgentDetectionOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  pathEnv?: string;
  versionTimeoutMs?: number;
}

interface EnvironmentInstallSpec {
  binary: string;
  configuredPath: string;
  configDir(env: NodeJS.ProcessEnv, home: string): string;
}

const INSTALL_SPECS: Record<EnvironmentId, EnvironmentInstallSpec> = {
  claude: {
    binary: "claude",
    configuredPath: "CLAUDE_CLI_PATH",
    configDir: (env, home) => env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
  },
  codex: {
    binary: "codex",
    configuredPath: "CODEX_CLI_PATH",
    configDir: (env, home) => env.CODEX_HOME || path.join(home, ".codex"),
  },
  gemini: {
    binary: "agy",
    configuredPath: "AGY_CLI_PATH",
    configDir: (_env, home) => path.join(home, ".gemini", "antigravity-cli"),
  },
};

const VERSION_CACHE_MS = 60_000;
const versionCache = new Map<string, { value: string | null; readAt: number }>();

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function homeDirectory(env: NodeJS.ProcessEnv, explicit?: string): string {
  if (explicit) return explicit;
  return env.HOME || env.USERPROFILE || os.homedir();
}

function binaryPath(spec: EnvironmentInstallSpec, env: NodeJS.ProcessEnv, home: string, pathEnv?: string): string | null {
  const configured = env[spec.configuredPath];
  if (configured) {
    if (configured.includes("/") || configured.includes("\\")) {
      return isExecutableFile(configured) ? configured : null;
    }
    return resolveBin(configured, { pathEnv: pathEnv ?? env.PATH });
  }
  return resolveBin(spec.binary, {
    pathEnv: pathEnv ?? env.PATH,
    probeDirs: spec.binary === "claude" ? [path.join(home, ".local", "bin")] : [],
  });
}

function readVersion(binary: string, timeout: number): string | null {
  const cached = versionCache.get(binary);
  if (cached && Date.now() - cached.readAt < VERSION_CACHE_MS) return cached.value;
  const command = spawnSpec(binary, ["--version"]);
  const result = spawnSync(command.command, command.args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
  const line = result.status === 0
    ? `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split(/\r?\n/).map((part) => part.trim()).find(Boolean)
    : undefined;
  const version = line?.match(/\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? null;
  versionCache.set(binary, { value: version, readAt: Date.now() });
  return version;
}

/** Detect one registered environment. Unknown ids, including the e2e mock, have no host CLI. */
export function detectAgentInstallation(
  agentId: string,
  options: AgentDetectionOptions = {},
): AgentInstallation {
  const spec = INSTALL_SPECS[agentId as EnvironmentId];
  if (!spec) return { installed: false, installedVersion: null };

  const env = options.env ?? process.env;
  const home = homeDirectory(env, options.homeDir);
  const binary = binaryPath(spec, env, home, options.pathEnv);
  return {
    installed: !!binary || isDirectory(spec.configDir(env, home)),
    installedVersion: binary ? readVersion(binary, options.versionTimeoutMs ?? 1_000) : null,
  };
}
