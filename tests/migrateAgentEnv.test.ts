import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { init, migrate } from "../lib/db";
import { getProviderSecret } from "../lib/providerSecrets";
import { insertProviderRow } from "../lib/providers/rows";

let open: Database.Database | undefined;
afterEach(() => open?.close());

function legacyDb() {
  const db = (open = new Database(":memory:"));
  init(db);
  return db;
}

function project(db: Database.Database, id: string, agentEnv: object, agent = "claude") {
  db.prepare("INSERT INTO projects (id, name, default_agent, agent_env, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    id,
    agent,
    JSON.stringify(agentEnv),
    Date.now(),
  );
}

function task(db: Database.Database, id: string, projectId: string, agentEnv: object, agent = "claude") {
  db.prepare("INSERT INTO tasks (id, project_id, title, agent, agent_env, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    projectId,
    id,
    agent,
    JSON.stringify(agentEnv),
    Date.now(),
    Date.now(),
  );
}

describe("legacy agent_env provider migration", () => {
  it("converts local, gateway, custom and cloud shapes and is idempotent", () => {
    const db = legacyDb();
    const cloud = {
      ANTHROPIC_BASE_URL: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "",
      OPENAI_BASE_URL: "",
      CODEX_MODEL: "",
    };
    project(db, "local", {
      ANTHROPIC_BASE_URL: "http://localhost:11434/v1",
      OPENAI_BASE_URL: "http://localhost:11434/v1",
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_MODEL: "qwen3-coder",
    });
    project(db, "gateway", {
      ANTHROPIC_BASE_URL: "http://gateway.example:4000",
      OPENAI_BASE_URL: "http://gateway.example:4000/v1",
      CALANDRIA_GATEWAY_BILLING: "subscription",
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
    });
    project(db, "custom", {
      ANTHROPIC_BASE_URL: "https://proxy.example/v1",
      ANTHROPIC_AUTH_TOKEN: "custom-token",
    });
    project(db, "cloud-project", cloud);
    task(db, "cloud-task", "cloud-project", cloud, "codex");
    insertProviderRow(db, { type: "openai" });

    migrate(db);

    const rows = db.prepare("SELECT id, type, config FROM model_providers ORDER BY created_at, rowid").all() as {
      id: string;
      type: string;
      config: string;
    }[];
    const byType = (type: string) => rows.find((row) => row.type === type)!;
    expect(byType("ollama")).toBeTruthy();
    expect(JSON.parse(byType("ollama").config)).toMatchObject({ base_url: "http://localhost:11434", default_model: "qwen3-coder" });
    expect(byType("litellm")).toBeTruthy();
    expect(JSON.parse(byType("litellm").config)).toMatchObject({ billing: "subscription", default_model: "claude-sonnet-4-5" });
    expect(byType("custom")).toBeTruthy();
    expect(JSON.parse(byType("custom").config)).toMatchObject({ base_url: "https://proxy.example", api: "anthropic" });
    expect(getProviderSecret(byType("custom").id, "key")).toBe("custom-token");
    expect(byType("openai")).toBeTruthy();

    const refs = db.prepare("SELECT id, default_provider_id FROM projects ORDER BY id").all() as { id: string; default_provider_id: string | null }[];
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "local", default_provider_id: expect.any(String) }),
      expect.objectContaining({ id: "gateway", default_provider_id: expect.any(String) }),
      expect.objectContaining({ id: "custom", default_provider_id: expect.any(String) }),
      expect.objectContaining({ id: "cloud-project", default_provider_id: expect.any(String) }),
    ]));
    const cloudProvider = (db.prepare("SELECT provider_id FROM tasks WHERE id = 'cloud-task'").get() as { provider_id: string }).provider_id;
    expect(cloudProvider).toBe(byType("openai").id);
    const before = rows.length;
    const envBefore = (db.prepare("SELECT agent_env FROM projects WHERE id = 'local'").get() as { agent_env: string }).agent_env;
    migrate(db);
    expect((db.prepare("SELECT COUNT(*) AS n FROM model_providers").get() as { n: number }).n).toBe(before);
    expect((db.prepare("SELECT agent_env FROM projects WHERE id = 'local'").get() as { agent_env: string }).agent_env).toBe(envBefore);
  });
});
