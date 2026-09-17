import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { init, migrate } from "../lib/db";
import { getProviderSecret } from "../lib/providerSecrets";
import { insertProviderRow } from "../lib/providers/rows";

let open: Database.Database | undefined;
afterEach(() => open?.close());

// A database as a shipped 0.14.x release left it: the provider tables exist
// and the agent_env columns are still there, carrying blobs that release's
// own migration did not convert. init() no longer creates those columns, so
// the pre-drop shape is restored here.
function legacyDb() {
  const db = (open = new Database(":memory:"));
  init(db);
  db.exec("ALTER TABLE projects ADD COLUMN agent_env TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE tasks ADD COLUMN agent_env TEXT NOT NULL DEFAULT ''");
  return db;
}

function hasAgentEnv(db: Database.Database, table: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "agent_env");
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
  it("converts local, gateway, custom and cloud shapes, drops the columns, and is idempotent", () => {
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
    // The blobs are read for the last time by that migrate() and the columns
    // go with it, so the conversion above can never run twice on one row.
    expect(hasAgentEnv(db, "projects")).toBe(false);
    expect(hasAgentEnv(db, "tasks")).toBe(false);

    // A second migrate() has no columns left to read and creates nothing.
    const before = rows.length;
    migrate(db);
    expect((db.prepare("SELECT COUNT(*) AS n FROM model_providers").get() as { n: number }).n).toBe(before);
    expect(hasAgentEnv(db, "projects")).toBe(false);
  });

  // A database created by this build has never had the columns, so the
  // conversion returns before preparing a statement that names them.
  it("migrates a fresh database that never carried the columns", () => {
    const db = (open = new Database(":memory:"));
    init(db);
    expect(hasAgentEnv(db, "projects")).toBe(false);
    expect(hasAgentEnv(db, "tasks")).toBe(false);
    expect(() => migrate(db)).not.toThrow();
  });
});
