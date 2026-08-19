import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

// The ticker is useless if it doesn't start with the server, and every link in
// that chain is in a different file and a different language. Pin the chain.
describe("scheduler boot chain", () => {
  it("server.js pings the scheduler route at boot", () => {
    const src = read("server.js");
    expect(src).toContain("/api/instance/scheduler");
  });

  it("the boot ping does not read as user activity to the idle daemon", () => {
    const src = read("server.js");
    const guard = src.slice(src.indexOf("const countsAsActivity"), src.indexOf("const countsAsActivity") + 600);
    expect(guard).toContain("/api/instance/scheduler");
  });

  it("middleware lets the service-token ping through", () => {
    expect(read("middleware.ts")).toContain('"/api/instance/scheduler"');
  });

  it("the route exists and starts the ticker", () => {
    const src = read("app/api/instance/scheduler/route.ts");
    expect(src).toContain("startScheduler");
    // Dynamic import, or Turbopack's async-external compilation bites (the same
    // bug the services-restore route documents).
    expect(src).toContain('await import("@/lib/scheduler")');
  });

  it("the pinned services-restore route still never reaches the scheduler", () => {
    expect(read("app/api/instance/services-restore/route.ts")).not.toContain("scheduler");
  });
});
