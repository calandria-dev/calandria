// Names the cause when the /pty WebSocket fails before it opens. The browser
// hides a refused upgrade's HTTP status, so the terminal asks
// `POST /pty/preflight` (server.js, lib/auth/pty-gate.mjs), which runs the
// upgrade's own gate and answers `{ ok, reason }`. A forward-auth proxy in front
// of the instance answers instead with a redirect to its sign-in page or a
// 401/403 of its own.

const red = (s: string) => `\r\n\x1b[31m[${s}]\x1b[0m\r\n`;

export const TERMINAL_MESSAGES = {
  auth: red("terminal refused: not signed in to this instance, or the proxy blocked the WebSocket upgrade"),
  origin: red(
    "terminal refused: this page's address is not an allowed origin for this instance " +
      "(set PUBLIC_BASE_URL or CALANDRIA_ALLOWED_ORIGINS to it)",
  ),
  sidecar: red("terminal unreachable: the server accepts this page, so is the pty-server sidecar running? The server log names the reason"),
  unknown: red("terminal unreachable: is the pty-server sidecar running?"),
} as const;

export type TerminalFailure = keyof typeof TERMINAL_MESSAGES;

/** Classify a socket that failed before `onopen` by asking the preflight route. */
export async function diagnoseTerminalFailure(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TerminalFailure> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/pty/preflight`, {
      method: "POST",
      credentials: "include",
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    // Network error or a cross-origin PUBLIC_BASE_URL that CORS hides.
    return "unknown";
  }
  if (res.type === "opaqueredirect" || res.redirected || (res.status >= 300 && res.status < 400)) return "auth";
  if (res.ok) return "sidecar";
  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => null) as { reason?: unknown } | null;
    return body?.reason === "origin" ? "origin" : "auth";
  }
  return "unknown";
}
