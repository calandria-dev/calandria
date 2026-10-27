import { describe, expect, it } from "vitest";
import { codexProviderError } from "@/lib/agents/codex/providerErrors";

describe("codexProviderError", () => {
  it("explains an upstream 503 and retains the original diagnostic and request id", () => {
    const original = 'unexpected status 503 Service Unavailable: {"detail":"Unable to verify Daybreak Blue access. Please try again."}, url: https://chatgpt.com/backend-api/codex/responses, request id: abc-123';
    const result = codexProviderError(original);
    expect(result.unavailable).toBe(true);
    expect(result.message).toContain("Upstream access verification is unavailable");
    expect(result.message).toContain(original);
    expect(result.requestId).toBe("abc-123");
    expect(result.message.match(/abc-123/g)).toHaveLength(1);
  });

  it("uses generic wording for a 503 without verification diagnostics", () => {
    const result = codexProviderError("unexpected status 503 Service Unavailable");
    expect(result.message).toContain("Codex provider temporarily unavailable (HTTP 503).");
    expect(result.message).toContain("provider service is temporarily unavailable");
    expect(result.message).not.toContain("verification");
    expect(codexProviderError(result.message)).toEqual(result);
  });

  it("recognizes a bare 503 Service Unavailable response", () => {
    expect(codexProviderError("503 Service Unavailable").unavailable).toBe(true);
  });

  it.each([401, 403])("preserves explicit HTTP %s when diagnostics mention a 503", status => {
    const result = codexProviderError({ status, message: `HTTP ${status} denied`, additionalDetails: "previous status 503" });
    expect(result).toMatchObject({ unavailable: false, message: `HTTP ${status} denied\nprevious status 503` });
  });

  it("labels a structured request ID even when its value occurs elsewhere", () => {
    const result = codexProviderError({ status: 503, message: "status 503", requestId: "503" });
    expect(result.message).toContain("Request ID: 503");
    expect(codexProviderError(result.message).requestId).toBe("503");
  });

  it("preserves the structured ID when a different ID appears in diagnostics", () => {
    const result = codexProviderError({ status: 503, message: "request id: old-id", requestId: "new-id" });
    expect(codexProviderError(result.message).requestId).toBe("new-id");
  });

  it("retains additional details on ordinary structured errors", () => {
    expect(codexProviderError({ message: "HTTP 403 forbidden", additionalDetails: "upstream reason" }).message)
      .toBe("HTTP 403 forbidden\nupstream reason");
  });

  it.each(["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"])("recognizes structured %s", key => {
    const result = codexProviderError({ message: "stream failed", additionalDetails: "proxy diagnostic", requestId: "req-1", codexErrorInfo: { [key]: { httpStatusCode: 503 } } });
    expect(result.unavailable).toBe(true);
    expect(result.message).toContain("proxy diagnostic");
    expect(result.message).toContain("Request ID: req-1");
    expect(result.requestId).toBe("req-1");
  });

  it.each(["request id: abc-1", "request_id=abc-1", "x-request-id: abc-1"])("extracts %s", text => {
    expect(codexProviderError(`status 503 ${text}`).requestId).toBe("abc-1");
  });

  it("extracts structured request_id", () => {
    expect(codexProviderError({ message: "failed", status: 503, request_id: "req-2" }).requestId).toBe("req-2");
  });

  it.each(["HTTP status 401 unauthorized", "HTTP status 403 forbidden", "503 tokens remaining", "request id: 503", "other error"])("preserves ordinary error %s", message => {
    expect(codexProviderError(new Error(message))).toMatchObject({ message, unavailable: false });
  });
});
