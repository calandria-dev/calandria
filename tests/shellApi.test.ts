import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MemoryStorage = Storage & { entries: Map<string, string> };

function memoryStorage(): MemoryStorage {
  const entries = new Map<string, string>();
  return {
    entries,
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, value); },
  };
}

function browser(storage = memoryStorage()) {
  const assign = vi.fn();
  vi.stubGlobal("window", {
    location: {
      href: "https://calandria.example/?project=p1&task=t1",
      origin: "https://calandria.example",
      assign,
    },
    sessionStorage: storage,
  });
  return { assign, storage };
}

describe("browser API fetches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses a manual redirect so forward-auth responses stay observable", async () => {
    browser();
    const response = new Response(JSON.stringify({ ok: true }));
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../app/shell/api");

    await expect(apiFetch("/api/projects", { cache: "no-store" })).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects", { cache: "no-store", redirect: "manual" });
  });

  it("navigates the top-level page when forward auth returns an opaque redirect", async () => {
    const { assign } = browser();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ type: "opaqueredirect" } as Response));
    const { apiFetch } = await import("../app/shell/api");

    await expect(apiFetch("/api/projects")).rejects.toThrow("Authentication session expired");
    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith("https://calandria.example/?project=p1&task=t1");
  });

  it("treats the browser CORS network error as an expired forward-auth session", async () => {
    const { assign } = browser();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { apiFetch } = await import("../app/shell/api");

    await expect(apiFetch("/api/tasks/t1/diff")).rejects.toThrow("Failed to fetch");
    expect(assign).toHaveBeenCalledWith("https://calandria.example/?project=p1&task=t1");
  });

  it("does not navigate when one API route fails but the auth probe is readable", async () => {
    const { assign } = browser();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ signedIn: false })));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../app/shell/api");

    await expect(apiFetch("/api/tasks/move?ids=t1")).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/auth/whoami", { cache: "no-store", redirect: "manual" });
    expect(assign).not.toHaveBeenCalled();
  });

  it("guards concurrent failures and reloads from navigation loops", async () => {
    const { assign, storage } = browser();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    let api = await import("../app/shell/api");

    await Promise.allSettled([api.apiFetch("/api/projects"), api.apiFetch("/api/tasks")]);
    expect(assign).toHaveBeenCalledOnce();

    vi.resetModules();
    api = await import("../app/shell/api");
    await expect(api.apiFetch("/api/projects")).rejects.toThrow("Failed to fetch");
    expect(assign).toHaveBeenCalledOnce();
    expect(storage.entries.size).toBe(1);
  });

  it("clears the persisted loop guard after a readable API response", async () => {
    const { assign, storage } = browser();
    storage.setItem("calandria:auth-navigation-at", String(Date.now()));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../app/shell/api");

    await apiFetch("/api/projects");
    expect(storage.entries.size).toBe(0);
    await expect(apiFetch("/api/projects")).rejects.toThrow("Failed to fetch");
    expect(assign).toHaveBeenCalledOnce();
  });

  it("keeps ordinary JSON API errors intact", async () => {
    browser();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "worktree is dirty" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    )));
    const { jget } = await import("../app/shell/api");

    await expect(jget("/api/tasks/t1/diff")).rejects.toThrow("worktree is dirty");
  });
});
