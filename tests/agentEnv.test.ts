import { describe, it, expect } from "vitest";
import { agentTurnEnv } from "@/lib/agentEnv";
import type { Project } from "@/lib/types";

// Issue #102: a main-turn agent process must not inherit the server's own
// NODE_ENV=production (it makes `npm install` in the user's project skip
// devDependencies and still exit 0) or its PORT (buildProjectContext tells
// every agent to bind its dev server to $PORT, so an unedited PORT points a
// task's server at Calandria itself).

const project = (port: number) => ({ port }) as Pick<Project, "port">;

describe("agentTurnEnv", () => {
  it("drops NODE_ENV even when the base env carries it", () => {
    const out = agentTurnEnv(project(4301), { NODE_ENV: "production", PATH: "/usr/bin" });
    expect("NODE_ENV" in out).toBe(false);
    expect(out.PATH).toBe("/usr/bin");
  });

  it("sets PORT from the project's own port", () => {
    const out = agentTurnEnv(project(4301), { PATH: "/usr/bin" });
    expect(out.PORT).toBe("4301");
  });

  it("deletes PORT when the project's port is 0", () => {
    const out = agentTurnEnv(project(0), { PORT: "3000", PATH: "/usr/bin" });
    expect("PORT" in out).toBe(false);
  });

  it("deletes PORT when there is no project at all", () => {
    const out = agentTurnEnv(null, { PORT: "3000", PATH: "/usr/bin" });
    expect("PORT" in out).toBe(false);
    const outUndef = agentTurnEnv(undefined, { PORT: "3000" });
    expect("PORT" in outUndef).toBe(false);
  });

  it("drops entries whose value is undefined", () => {
    const out = agentTurnEnv(project(4301), { PATH: "/usr/bin", GHOST: undefined });
    expect("GHOST" in out).toBe(false);
  });

  it("preserves PATH and other ordinary vars untouched", () => {
    const out = agentTurnEnv(project(4301), { PATH: "/usr/bin:/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-x" });
    expect(out.PATH).toBe("/usr/bin:/bin");
    expect(out.HOME).toBe("/home/x");
    expect(out.ANTHROPIC_API_KEY).toBe("sk-x");
  });

  it("never mutates the base object", () => {
    const base = { NODE_ENV: "production", PORT: "3000", PATH: "/usr/bin" };
    const snapshot = { ...base };
    agentTurnEnv(project(4301), base);
    expect(base).toEqual(snapshot);
  });
});
