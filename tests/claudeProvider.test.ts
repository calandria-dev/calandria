import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isBedrockConfigured } from "@/lib/agents/claude/provider";
import { tmpDir } from "./helpers";

describe("Claude provider configuration", () => {
  it("detects Bedrock from the process environment", () => {
    expect(isBedrockConfigured({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
    expect(isBedrockConfigured({ CLAUDE_CODE_USE_BEDROCK: "false" })).toBe(false);
  });

  it("detects /setup-bedrock settings persisted by Claude Code", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
      env: { CLAUDE_CODE_USE_BEDROCK: "true", AWS_PROFILE: "work" },
    }));
    expect(isBedrockConfigured({ CLAUDE_CONFIG_DIR: dir })).toBe(true);
  });
});
