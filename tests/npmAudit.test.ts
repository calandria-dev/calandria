// The `Audit (npm)` job's guard (issue #207). Every fixture below is real
// output from `npm audit --package-lock-only --omit=dev --audit-level=high
// --json` on npm 10.9.3: the repo's own lockfile for the clean case, a scratch
// lockfile pinned to lodash@4.17.11 for the advisory case, a closed port and a
// stub registry answering 400 for the two registry failures.

import { describe, expect, it } from "vitest";
import { classifyAudit, formatAdvisories } from "../scripts/npm-audit.mjs";

const CLEAN = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
});

const ADVISORY = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    lodash: {
      name: "lodash",
      severity: "critical",
      isDirect: true,
      range: "<=4.17.23",
      via: [
        {
          source: 1106918,
          name: "lodash",
          title: "Prototype Pollution in lodash",
          url: "https://github.com/advisories/GHSA-jf85-cpcp-j695",
          severity: "critical",
          range: "<4.17.19",
        },
      ],
    },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 } },
});

// The failure reported in issue #207, reproduced against a registry stub.
const REGISTRY_400 = JSON.stringify({
  message: "400 Bad Request - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick - Bad Request",
  method: "POST",
  statusCode: 400,
  body: { error: "Bad Request" },
  error: { summary: "", detail: "" },
});

const REGISTRY_UNREACHABLE = JSON.stringify({
  message: "request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed, reason: connect ECONNREFUSED",
  error: { summary: "", detail: "" },
});

describe("npm audit registry guard", () => {
  it("passes a clean report", () => {
    expect(classifyAudit({ code: 0, stdout: CLEAN }).kind).toBe("clean");
  });

  it("fails a report that contains advisories at the threshold", () => {
    const verdict = classifyAudit({ code: 1, stdout: ADVISORY });
    expect(verdict.kind).toBe("advisory");
    const { lines, summary } = formatAdvisories(verdict.report);
    expect(summary).toBe("1 critical");
    expect(lines.join("\n")).toContain("GHSA-jf85-cpcp-j695");
  });

  it("reads a 400 from the advisory endpoint as unavailable, not as a finding", () => {
    const verdict = classifyAudit({ code: 1, stdout: REGISTRY_400 });
    expect(verdict.kind).toBe("registry-error");
    expect(verdict.reason).toContain("400 Bad Request");
  });

  it("reads an unreachable registry as unavailable", () => {
    expect(classifyAudit({ code: 1, stdout: REGISTRY_UNREACHABLE }).kind).toBe("registry-error");
  });

  it("reads no output and unparseable output as unavailable", () => {
    expect(classifyAudit({ code: 1, stdout: "" }).kind).toBe("registry-error");
    expect(classifyAudit({ code: 1, stdout: "<html>502 Bad Gateway</html>" }).kind).toBe("registry-error");
  });

  it("never treats a registry failure as clean when npm exits nonzero", () => {
    for (const stdout of [REGISTRY_400, REGISTRY_UNREACHABLE, "", "garbage"]) {
      expect(classifyAudit({ code: 1, stdout }).kind).not.toBe("clean");
    }
  });

  it("does not fail a zero exit, whatever npm printed", () => {
    expect(classifyAudit({ code: 0, stdout: "" }).kind).toBe("clean");
  });
});
