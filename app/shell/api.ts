// Tiny fetch helpers used throughout the Calandria client.

const AUTH_NAVIGATION_KEY = "calandria:auth-navigation-at";
const AUTH_NAVIGATION_COOLDOWN_MS = 30_000;
let authNavigationStarted = false;

function isSameOriginApiRequest(input: RequestInfo | URL): boolean {
  const raw = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
  if (typeof window === "undefined") return raw.startsWith("/api/");
  try {
    const url = new URL(raw, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function clearAuthNavigationGuard(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(AUTH_NAVIGATION_KEY);
  } catch { /* storage can be disabled; the in-memory guard still works */ }
}

function navigateThroughAuthOnce(): void {
  if (typeof window === "undefined" || authNavigationStarted) return;

  const now = Date.now();
  try {
    const lastAttempt = Number(window.sessionStorage.getItem(AUTH_NAVIGATION_KEY));
    if (Number.isFinite(lastAttempt) && lastAttempt > 0 && now - lastAttempt < AUTH_NAVIGATION_COOLDOWN_MS) {
      return;
    }
    window.sessionStorage.setItem(AUTH_NAVIGATION_KEY, String(now));
  } catch { /* storage can be disabled; the in-memory guard still works */ }

  authNavigationStarted = true;
  window.location.assign(window.location.href);
}

function isCrossOriginRedirect(response: Response): boolean {
  if (response.type === "opaqueredirect") return true;
  if (!response.redirected || typeof window === "undefined") return false;
  try {
    return new URL(response.url).origin !== window.location.origin;
  } catch {
    return false;
  }
}

async function forwardAuthSessionExpired(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/whoami", { cache: "no-store", redirect: "manual" });
    if (isCrossOriginRedirect(response)) return true;
    clearAuthNavigationGuard();
    return false;
  } catch {
    // A full network interruption is indistinguishable from the CORS error
    // produced by a browser that follows the forward-auth redirect. The
    // navigation guard limits this fallback to one reload.
    return true;
  }
}

/**
 * Fetch a same-origin API route and recover when forward auth turns the request
 * into an unreadable cross-origin redirect. A top-level reload lets the ingress
 * complete its login flow, while the session guard prevents reload loops.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const apiRequest = isSameOriginApiRequest(input);
  try {
    const response = await fetch(input, apiRequest ? { ...init, redirect: "manual" } : init);
    if (apiRequest && isCrossOriginRedirect(response)) {
      navigateThroughAuthOnce();
      throw new Error("Authentication session expired");
    }
    if (apiRequest) clearAuthNavigationGuard();
    return response;
  } catch (error) {
    // Browsers surface a followed cross-origin forward-auth redirect as an
    // indistinguishable network TypeError. Probe a stable API route so one
    // failed endpoint does not reload an otherwise authenticated page.
    if (apiRequest && error instanceof TypeError && await forwardAuthSessionExpired()) {
      navigateThroughAuthOnce();
    }
    throw error;
  }
}

// Routes report failures as JSON `{ error }`; unwrap that so surfaced messages
// read "worktree is dirty" instead of a raw JSON blob (transcript system errors,
// modal error notes and ErrNote all show this string verbatim).
async function fail(r: Response): Promise<never> {
  const raw = await r.text();
  let msg = raw || `${r.status} ${r.statusText}`;
  try {
    const j = JSON.parse(raw);
    if (typeof j?.error === "string" && j.error) msg = j.error;
  } catch { /* not JSON, keep the raw body */ }
  throw new Error(msg);
}

export async function jget<T>(url: string): Promise<T> {
  const r = await apiFetch(url, { cache: "no-store" });
  if (!r.ok) await fail(r);
  return r.json();
}
export async function jsend<T>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) await fail(r);
  return r.json();
}
