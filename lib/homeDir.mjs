/* The current user's home directory, for every module the Next build bundles.
 *
 * Next's file tracer (@vercel/nft) evaluates `os.homedir()` at build time and
 * globs whatever path expression it lands in, so `path.join(os.homedir(),
 * ".codex", x)` makes the build walk the whole of `~/.codex`, and a bare home
 * walk dies on an unreadable entry (EPERM on Windows'
 * `C:\Users\<user>\Application Data` junction). The tracer analyzes one module
 * at a time and cannot see through a call into another module, so code under
 * `lib/` and `app/` reads the home directory through this function instead.
 * `tests/homeDirTrace.test.ts` keeps it that way.
 *
 * Plain .mjs so lib/storage.mjs, which the CommonJS server.js imports, can use
 * it; must be COPY'd into the runtime image (see the Dockerfile).
 */

import os from "node:os";

export function homeDir() {
  return os.homedir();
}
