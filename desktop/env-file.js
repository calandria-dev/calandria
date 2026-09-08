/* The desktop app's one launch-time env source.
 *
 * Every other Calandria launch path has a wrapper in front of it: `npm start`
 * / `npm run dev` inherit whatever exported the shell that ran them, and a
 * self-hosted deployment is expected to write a launcher script that sources
 * a file and `exec npm start`s (docs/SELF_HOSTING.md). The desktop app has no
 * such script: a Finder double-click, a Dock click or a Login Item hands
 * `main.js` launchd's own minimal environment, with nothing sourced and
 * nothing exported. This file is the desktop replacement for that launcher:
 * a small, predictable file the supervisor reads before spawning either
 * sidecar.
 *
 * The parser is intentionally simple: no variable expansion (`$HOME`), no
 * command substitution, no `source`d files. A predictable parser readable in
 * thirty seconds is the point of a plain env file instead of execing a shell
 * script. For real shell semantics, use CALANDRIA_ENV_FILE to point at a
 * script and source it yourself before launching the app; this file only
 * ever reads static KEY=VALUE lines.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Where the env file lives. CALANDRIA_ENV_FILE wins outright when set; the
 * default is one documented convention (`~/.config/calandria/env`), the same
 * on every platform, since this file is read before anything else about the
 * platform is decided.
 */
function envFilePath(env = process.env) {
  if (env.CALANDRIA_ENV_FILE) return env.CALANDRIA_ENV_FILE;
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "calandria", "env");
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Undo the four escapes a double-quoted value may carry. Single-quoted
 *  values are taken literally, never unescaped, matching a POSIX shell. */
function unescapeDouble(s) {
  return s.replace(/\\([\\nrt"])/g, (_, c) => ({ "\\": "\\", n: "\n", r: "\r", t: "\t", '"': '"' })[c]);
}

/**
 * Parse KEY=VALUE lines. Returns `{ vars, skipped }`, where `skipped` names
 * every line that could not be turned into a variable and why, with a
 * 1-indexed line number so a warning in the boot log points at something the
 * user can actually go fix.
 */
function parseEnvFile(text) {
  const vars = {};
  const skipped = [];
  // Several editors write a leading UTF-8 BOM for a "plain text" file on
  // save; strip it so the first KEY doesn't parse as a name with a stray
  // non-ASCII prefix.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = trimmed.replace(/^export\s+/, "");
    const eq = line.indexOf("=");
    if (eq === -1) {
      skipped.push({ line: lineNo, reason: "no =" });
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      skipped.push({ line: lineNo, reason: "invalid name" });
      continue;
    }
    // Split on the first '=' only: a value legitimately containing '=' (a
    // base64 blob, a query string) must not be truncated at it.
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
        value = value.slice(1, -1);
        if (quote === '"') value = unescapeDouble(value);
        // Single-quoted values are taken literally, with no unescaping, matching shell semantics.
      }
    }
    // An unquoted value is taken whole, with no trailing-comment stripping.
    // There is no comment syntax inside a value: tokens (API keys, PATH
    // segments) routinely contain '#', and truncating one there would be a
    // far worse surprise than a trailing comment that doesn't work.
    vars[key] = value; // later line wins over an earlier one for the same key
  }
  return { vars, skipped };
}

/**
 * Load and parse the env file. Never throws: a missing or unreadable file is
 * the common case, since most installs won't have one, and must not stop the
 * app from launching. Any failure reading it comes back as `found: false`
 * with no vars and no warnings, and the caller decides what to log.
 */
function loadEnvFile({ env = process.env, file = null } = {}) {
  const p = file || envFilePath(env);
  try {
    const text = fs.readFileSync(p, "utf8");
    const { vars, skipped } = parseEnvFile(text);
    return { path: p, found: true, vars, skipped };
  } catch {
    return { path: p, found: false, vars: {}, skipped: [] };
  }
}

module.exports = { envFilePath, parseEnvFile, loadEnvFile };
