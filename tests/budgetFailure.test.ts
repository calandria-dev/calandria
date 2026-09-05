import { describe, expect, it } from "vitest";
import { isBudgetExceeded, BUDGET_EXCEEDED_NOTICE, BUDGET_EXCEEDED_BANNER_REASON } from "@/lib/budgetFailure";
import { isAuthFailure } from "@/lib/authFailure";
import { isPromptTooLong } from "@/lib/promptLimits";
import { isUsageLimit } from "@/lib/usageLimit";
import { isApprovalBlocked } from "@/lib/approvalFailure";

// Real-shaped fixtures for the two ways LiteLLM reports a spent budget (see
// docs/AGENTS.md, "Attribution, budgets and failures"):
//   - a proxy-level rejection (key/user/team budget), embedding a JSON body
//     fragment carrying `"type": "budget_exceeded"`;
//   - the end-user budget check's own exception class prefix.
const PROXY_REJECTION =
  'API Error: 400 Budget has been exceeded! Current cost: 12.5, Max budget: 10.0 ' +
  '{"error": {"message": "Budget has been exceeded! Current cost: 12.5, Max budget: 10.0", ' +
  '"type": "budget_exceeded", "param": null, "code": "400"}}';

const END_USER_EXCEEDED =
  "litellm.exceptions.BudgetExceededError: ExceededBudget: Current spend for user " +
  "d3f1c9a2-1234-4a5b-9c6d-abcdef012345 has exceeded their budget of $10.00";

// Copied verbatim from tests/approvalFailure.test.ts (not exported there) so
// this suite can prove budget detection doesn't steal an approval failure's
// signature either.
const DOWNGRADE =
  "Configured value for `approval_policy` is disallowed by requirements; falling back to required value " +
  "UnlessTrusted. Details: invalid value for `approval_policy`: `Never` is not in the allowed set " +
  "[UnlessTrusted, OnRequest, Granular(GranularApprovalConfig { sandbox_approval: true, rules: true, " +
  "skill_approval: true, request_permissions: true, mcp_elicitations: true })] (set by enterprise-managed " +
  "requirements All users (93155247-b78f-4910-a06e-e1ed3c113a34))";

const EXEC_REJECTIONS = [
  'command execution approval is not supported in exec mode for thread 019ff714-aaaa-bbbb-cccc-dddddddddddd',
  'exec_command failed for session 1: Rejected("approval request failed")',
  "approval policy is UnlessTrusted; reject command — you cannot ask for escalated permissions if the " +
    "approval policy is UnlessTrusted",
];

describe("isBudgetExceeded", () => {
  it("matches the proxy-level budget_exceeded rejection", () => {
    expect(isBudgetExceeded(PROXY_REJECTION)).toBe(true);
  });

  it("matches the end-user ExceededBudget exception class", () => {
    expect(isBudgetExceeded(END_USER_EXCEEDED)).toBe(true);
  });

  it("does not match ordinary work failures", () => {
    for (const msg of [
      "Run ended: model_error",
      "Command failed with exit code 1",
      "prompt is too long: 250000 tokens > 200000 maximum",
    ]) {
      expect(isBudgetExceeded(msg)).toBe(false);
    }
  });

  it("does not match null, undefined or empty string", () => {
    expect(isBudgetExceeded(null)).toBe(false);
    expect(isBudgetExceeded(undefined)).toBe(false);
    expect(isBudgetExceeded("")).toBe(false);
  });

  // publishTurnError picks exactly one notice per failure; budget detection
  // must not steal another classifier's signature, nor the reverse.
  it("stays disjoint from the other recoverable-failure classifiers", () => {
    for (const msg of [PROXY_REJECTION, END_USER_EXCEEDED]) {
      expect(isAuthFailure(msg)).toBe(false);
      expect(isPromptTooLong(msg)).toBe(false);
      expect(isUsageLimit(msg)).toBe(false);
      expect(isApprovalBlocked(msg)).toBe(false);
    }
    // …and an approval failure's own signatures must not read as a budget one.
    for (const msg of [DOWNGRADE, ...EXEC_REJECTIONS]) {
      expect(isBudgetExceeded(msg)).toBe(false);
    }
  });
});

describe("BUDGET_EXCEEDED_NOTICE", () => {
  it("is non-empty, mentions budget, and doesn't claim to reconnect anything", () => {
    expect(BUDGET_EXCEEDED_NOTICE.length).toBeGreaterThan(0);
    expect(BUDGET_EXCEEDED_NOTICE.toLowerCase()).toContain("budget");
    expect(BUDGET_EXCEEDED_NOTICE.toLowerCase()).not.toContain("reconnect");
  });
});

describe("BUDGET_EXCEEDED_BANNER_REASON", () => {
  // app/shell/AgentConnect.tsx matches this string verbatim to swap in
  // budget-specific banner copy instead of "Reconnect".
  it("is non-empty, mentions budget, and doesn't claim to reconnect anything", () => {
    expect(BUDGET_EXCEEDED_BANNER_REASON.length).toBeGreaterThan(0);
    expect(BUDGET_EXCEEDED_BANNER_REASON.toLowerCase()).toContain("budget");
    expect(BUDGET_EXCEEDED_BANNER_REASON.toLowerCase()).not.toContain("reconnect");
  });
});
