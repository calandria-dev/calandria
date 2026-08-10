import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const enabled = (value: unknown) => ["1", "true", "on"].includes(String(value ?? "").toLowerCase());

/** Whether this Operator process is configured to route Claude through AWS. */
export function isBedrockConfigured(env: Record<string, string | undefined> = process.env): boolean {
  if (enabled(env.CLAUDE_CODE_USE_BEDROCK) || enabled(env.CLAUDE_CODE_USE_MANTLE)) return true;
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")) as {
      env?: Record<string, unknown>;
    };
    return enabled(settings.env?.CLAUDE_CODE_USE_BEDROCK) || enabled(settings.env?.CLAUDE_CODE_USE_MANTLE);
  } catch {
    return false;
  }
}
