/** Normalize upstream availability failures while retaining the CLI's diagnostics. */
export function codexProviderError(error: unknown): {
  message: string;
  requestId?: string;
  unavailable: boolean;
} {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const message = typeof error === "string" ? error :
    typeof record?.message === "string" ? record.message : String(error);
  const details = typeof record?.additionalDetails === "string" ? record.additionalDetails : "";
  const diagnostic = details && !message.includes(details) ? `${message}\n${details}` : message;
  const info = record?.codexErrorInfo;
  const infoRecord = info && typeof info === "object" ? info as Record<string, unknown> : undefined;
  const statusRecords = [record, infoRecord, ...["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"].map(key => {
    const value = infoRecord?.[key];
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  })];
  const status = statusRecords.flatMap(item => [item?.httpStatusCode, item?.statusCode, item?.status, item?.code])
    .find(value => (typeof value === "number" || (typeof value === "string" && /^\d{3}$/.test(value))) && Number(value) >= 100 && Number(value) <= 599);
  const unavailable = status !== undefined ? Number(status) === 503 :
    /\b(?:unexpected\s+status|http(?:\s+status)?|status(?:\s+code)?|code)\s*[:=]?\s*503\b/i.test(diagnostic) ||
    /\b503\s+service\s+unavailable\b/i.test(diagnostic);
  const explicitId = statusRecords.map(item => item?.requestId ?? item?.request_id).find(value => typeof value === "string" && value.trim());
  const textId = diagnostic.match(/\b(?:x-request-id|request[ _-]?id)\s*[:=]\s*["']?([\w.-]+)/i)?.[1];
  const requestId = typeof explicitId === "string" ? explicitId : textId;
  if (!unavailable) return { message: diagnostic, ...(requestId ? { requestId } : {}), unavailable: false };
  if (message.startsWith("Codex provider temporarily unavailable (HTTP 503).")) {
    return { message: diagnostic, ...(requestId ? { requestId } : {}), unavailable: true };
  }
  const idLine = requestId && textId !== requestId ? `Request ID: ${requestId}\n` : "";
  const explanation = /\b(?:verify|verification)\b/i.test(diagnostic)
    ? "Upstream access verification is unavailable; please try again."
    : "The provider service is temporarily unavailable; please try again.";
  return {
    message: `Codex provider temporarily unavailable (HTTP 503). ${explanation}\n\n${idLine}${diagnostic}`,
    ...(requestId ? { requestId } : {}),
    unavailable: true,
  };
}
