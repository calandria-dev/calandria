/* Where the desktop app's config directory is. One line of policy, its own file.
 *
 * Split out of instances.js when instance-auth.js needed it too: that module
 * holds `normalizeAuth`, which instances.js calls on every load, and it writes
 * `credentials.json` NEXT TO `instances.json`, which means it needs this. Left
 * where it was, the two files would require each other in a cycle — which Node
 * tolerates by handing one of them a half-built exports object, and which is a
 * genuinely awful bug to find later.
 *
 * `instances.js` re-exports `instancesFilePath` unchanged, so nothing that
 * imports it has to know this file exists.
 */
"use strict";

const os = require("node:os");
const path = require("node:path");

/**
 * `~/.config/calandria/instances.json` on every platform.
 *
 * Mirrors env-file.js's `envFilePath` exactly, including the one-path-on-every-
 * platform rule and the env override, so the desktop app's config files are
 * never in two places.
 */
function instancesFilePath(env = process.env) {
  if (env.CALANDRIA_INSTANCES_FILE) return env.CALANDRIA_INSTANCES_FILE;
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "calandria", "instances.json");
}

module.exports = { instancesFilePath };
