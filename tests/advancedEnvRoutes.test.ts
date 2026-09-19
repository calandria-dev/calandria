import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/settings/environment/route";
import { DELETE, PATCH } from "@/app/api/settings/environment/[id]/route";
import { environmentFilePath, setRuntimeStateAdapter, setStoreIo } from "@/lib/advanced-env/store";

// Synthetic sentinels. Nothing here is a real credential.
const SECRET_VALUE = "synthetic-sentinel-4c71";
const SECRET_NAME = "MY_SYNTHETIC_TOKEN";

const ORIGIN = "http://localhost:3000";
const HOST = "localhost:3000";

const savedEnv = {
  CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN,
  CF_ACCESS_AUD: process.env.CF_ACCESS_AUD,
  SERVICE_TOKEN: process.env.SERVICE_TOKEN,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
};

function accessMode(on: boolean) {
  if (on) {
    process.env.CF_ACCESS_TEAM_DOMAIN = "test-team.cloudflareaccess.com";
    process.env.CF_ACCESS_AUD = "test-aud";
  } else {
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    delete process.env.CF_ACCESS_AUD;
  }
}

type Headers = Record<string, string>;

const browser: Headers = { host: HOST, origin: ORIGIN, "sec-fetch-site": "same-origin" };

function request(method: string, body: unknown, headers: Headers = browser, url = "http://localhost:3000/api/settings/environment") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function bodyOf(res: Response) {
  return (await res.json()) as Record<string, unknown> & {
    rows?: { id: string; name: string | null; value: string | null; secret: boolean; hasValue: boolean }[];
    revision?: number;
    row?: { id: string; name: string | null; value: string | null };
    error?: string;
    code?: string;
    currentRevision?: number;
  };
}

async function list() {
  return bodyOf(await GET(request("GET", undefined)));
}

async function create(over: Record<string, unknown> = {}) {
  const current = await list();
  const res = await POST(
    request("POST", { scope: "app", name: "MY_CUSTOM_VAR", value: "1", secret: false, expectedRevision: current.revision, ...over }),
  );
  return { res, body: await bodyOf(res) };
}

beforeEach(() => {
  accessMode(false);
  delete process.env.SERVICE_TOKEN;
  fs.rmSync(environmentFilePath(), { force: true });
  setRuntimeStateAdapter(null);
  setStoreIo(null);
});

afterEach(() => {
  fs.rmSync(environmentFilePath(), { force: true });
  setRuntimeStateAdapter(null);
  setStoreIo(null);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GET /api/settings/environment", () => {
  it("returns rows, revision, catalog and instance identity, uncached", async () => {
    await create({ name: "MY_CUSTOM_VAR", value: "1" });
    const res = await GET(request("GET", undefined));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await bodyOf(res);
    expect(body.rows).toHaveLength(1);
    expect(body.revision).toBe(1);
    expect(Array.isArray(body.catalog)).toBe(true);
    expect((body.catalog as { ownership: string }[]).every((d) => d.ownership === "editable")).toBe(true);
    expect((body.instance as { host: string }).host).toBe(HOST);
  });

  it("reports restartRequired and a load error field", async () => {
    const body = await list();
    expect(body.restartRequired).toBe(false);
    expect(body.loadError).toBeNull();
  });

  it("never returns a secret name or value", async () => {
    await create({ name: SECRET_NAME, value: SECRET_VALUE, secret: true });
    const res = await GET(request("GET", undefined));
    const text = await res.text();
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain(SECRET_NAME);
    const rows = (JSON.parse(text) as { rows: { name: string | null; value: string | null; hasValue: boolean }[] }).rows;
    expect(rows[0]).toMatchObject({ name: null, value: null, hasValue: true });
  });
});

describe("browser-only mutation guard", () => {
  const cases: { label: string; headers: Headers }[] = [
    { label: "no browser metadata at all", headers: { host: HOST } },
    { label: "an origin with no Sec-Fetch-Site", headers: { host: HOST, origin: ORIGIN } },
    { label: "Sec-Fetch-Site with no origin", headers: { host: HOST, "sec-fetch-site": "same-origin" } },
    { label: "a foreign origin", headers: { host: HOST, origin: "https://evil.example", "sec-fetch-site": "same-origin" } },
    { label: "a cross-site fetch", headers: { host: HOST, origin: ORIGIN, "sec-fetch-site": "cross-site" } },
    { label: "a same-site fetch from a sibling host", headers: { host: HOST, origin: ORIGIN, "sec-fetch-site": "same-site" } },
  ];

  for (const mode of [false, true]) {
    const modeLabel = mode ? "Access mode" : "local mode";

    it(`accepts a same-origin browser request in ${modeLabel}`, async () => {
      accessMode(mode);
      const { res } = await create();
      expect(res.status).toBe(200);
    });

    for (const c of cases) {
      it(`refuses ${c.label} in ${modeLabel}`, async () => {
        accessMode(mode);
        const res = await POST(
          request("POST", { scope: "app", name: "MY_CUSTOM_VAR", value: "1", secret: false, expectedRevision: 0 }, c.headers),
        );
        expect(res.status).toBe(403);
        expect((await list()).rows).toHaveLength(0);
      });
    }

    it(`refuses a service-token-only request in ${modeLabel}`, async () => {
      accessMode(mode);
      process.env.SERVICE_TOKEN = "synthetic-service-token";
      const res = await POST(
        request("POST", { scope: "app", name: "MY_CUSTOM_VAR", value: "1", secret: false, expectedRevision: 0 }, {
          host: HOST,
          "x-service-token": "synthetic-service-token",
        }),
      );
      expect(res.status).toBe(403);
      expect((await list()).rows).toHaveLength(0);
    });
  }

  it("guards PATCH and DELETE too", async () => {
    const { body } = await create();
    const id = body.row!.id;
    const patched = await PATCH(request("PATCH", { value: "2", expectedRevision: 1 }, { host: HOST }), params(id));
    expect(patched.status).toBe(403);
    const removed = await DELETE(request("DELETE", { expectedRevision: 1 }, { host: HOST }), params(id));
    expect(removed.status).toBe(403);
    expect((await list()).rows).toHaveLength(1);
  });

  it("honors an allowed LAN origin in local mode", async () => {
    process.env.PUBLIC_BASE_URL = "http://calandria.lan:3000";
    const res = await POST(
      request("POST", { scope: "app", name: "MY_CUSTOM_VAR", value: "1", secret: false, expectedRevision: 0 }, {
        host: "calandria.lan:3000",
        origin: "http://calandria.lan:3000",
        "sec-fetch-site": "same-origin",
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/settings/environment", () => {
  it("creates a row and returns the new revision", async () => {
    const { res, body } = await create({ name: "MY_CUSTOM_VAR", value: "created" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body.revision).toBe(1);
    expect(body.row).toMatchObject({ name: "MY_CUSTOM_VAR", value: "created", scope: "app" });
  });

  it("rejects a reserved name with 400", async () => {
    const { res, body } = await create({ name: "CALANDRIA_DB_DIR", value: "/tmp" });
    expect(res.status).toBe(400);
    expect(body.code).toBe("reserved_name");
  });

  it("rejects a duplicate name with 409", async () => {
    await create({ name: "MY_CUSTOM_VAR" });
    const { res, body } = await create({ name: "my_custom_var" });
    expect(res.status).toBe(409);
    expect(body.code).toBe("duplicate_name");
  });

  it("rejects a stale revision with 409 and reports the current one", async () => {
    await create({ name: "MY_FIRST_VAR" });
    const res = await POST(request("POST", { scope: "app", name: "MY_SECOND_VAR", value: "1", secret: false, expectedRevision: 0 }));
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).currentRevision).toBe(1);
  });

  it("requires scope, name, value and expectedRevision", async () => {
    expect((await POST(request("POST", { name: "MY_VAR", value: "1", expectedRevision: 0 }))).status).toBe(400);
    expect((await POST(request("POST", { scope: "app", value: "1", expectedRevision: 0 }))).status).toBe(400);
    expect((await POST(request("POST", { scope: "app", name: "MY_VAR", expectedRevision: 0 }))).status).toBe(400);
    expect((await POST(request("POST", { scope: "app", name: "MY_VAR", value: "1" }))).status).toBe(400);
  });

  it("stores an empty value and reports hasValue", async () => {
    const { body } = await create({ name: "MY_EMPTY_VAR", value: "" });
    expect(body.row).toMatchObject({ value: "", hasValue: true });
  });

  it("reports a write failure without touching the saved file", async () => {
    await create({ name: "MY_KEPT_VAR", value: "before" });
    setStoreIo({
      writeRestricted() {
        throw new Error("write refused");
      },
      rename() {},
      restrict() {},
    });
    const { res, body } = await create({ name: "MY_OTHER_VAR", value: "after" });
    expect(res.status).toBe(500);
    expect(body.error).not.toContain("after");
    setStoreIo(null);
    const after = await list();
    expect(after.rows).toHaveLength(1);
    expect(after.revision).toBe(1);
  });
});

describe("PATCH /api/settings/environment/[id]", () => {
  it("renames without changing the value", async () => {
    const { body } = await create({ name: "MY_OLD_NAME", value: "kept" });
    const res = await PATCH(request("PATCH", { name: "MY_NEW_NAME", expectedRevision: body.revision }), params(body.row!.id));
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).row).toMatchObject({ name: "MY_NEW_NAME", value: "kept" });
  });

  it("keeps the old value when value is omitted and empties it when supplied empty", async () => {
    const { body } = await create({ name: "MY_VALUE_VAR", value: "before" });
    const kept = await bodyOf(await PATCH(request("PATCH", { expectedRevision: body.revision }), params(body.row!.id)));
    expect(kept.row).toMatchObject({ value: "before" });
    const emptied = await bodyOf(await PATCH(request("PATCH", { value: "", expectedRevision: kept.revision }), params(body.row!.id)));
    expect(emptied.row).toMatchObject({ value: "" });
  });

  it("rejects a null field with 400", async () => {
    const { body } = await create({ name: "MY_NULL_VAR", value: "before" });
    const res = await PATCH(request("PATCH", { value: null, expectedRevision: body.revision }), params(body.row!.id));
    expect(res.status).toBe(400);
  });

  it("requires confirmExpose to turn secret off", async () => {
    const { body } = await create({ name: SECRET_NAME, value: SECRET_VALUE, secret: true });
    const refused = await PATCH(request("PATCH", { secret: false, expectedRevision: body.revision }), params(body.row!.id));
    expect(refused.status).toBe(400);
    expect((await bodyOf(refused)).code).toBe("confirm_expose");

    const current = await list();
    const confirmed = await PATCH(
      request("PATCH", { secret: false, confirmExpose: true, expectedRevision: current.revision }),
      params(body.row!.id),
    );
    expect(confirmed.status).toBe(200);
    expect((await bodyOf(confirmed)).row).toMatchObject({ name: SECRET_NAME, value: SECRET_VALUE });
  });

  it("renames a secret without echoing it back", async () => {
    const { body } = await create({ name: SECRET_NAME, value: SECRET_VALUE, secret: true });
    const res = await PATCH(request("PATCH", { name: "MY_RENAMED_TOKEN", expectedRevision: body.revision }), params(body.row!.id));
    const text = await res.text();
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain("MY_RENAMED_TOKEN");
  });

  it("returns 404 for an unknown id", async () => {
    await create();
    const res = await PATCH(request("PATCH", { value: "x", expectedRevision: 1 }), params("no-such-id"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/settings/environment/[id]", () => {
  it("removes only the saved row", async () => {
    const first = await create({ name: "MY_FIRST_VAR" });
    await create({ name: "MY_SECOND_VAR" });
    const current = await list();
    const res = await DELETE(request("DELETE", { expectedRevision: current.revision }), params(first.body.row!.id));
    expect(res.status).toBe(200);
    const after = await list();
    expect(after.rows!.map((r) => r.name)).toEqual(["MY_SECOND_VAR"]);
  });

  it("rejects a stale revision with 409", async () => {
    const { body } = await create();
    const res = await DELETE(request("DELETE", { expectedRevision: body.revision! - 1 }), params(body.row!.id));
    expect(res.status).toBe(409);
    expect((await list()).rows).toHaveLength(1);
  });

  it("returns 404 for an unknown id", async () => {
    await create();
    const res = await DELETE(request("DELETE", { expectedRevision: 1 }), params("no-such-id"));
    expect(res.status).toBe(404);
  });
});
