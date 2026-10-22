// SDK-free metadata for live Advanced Settings proposals (contract
// work-center/1). The proposal's own state is the mandatory permission card
// (lib/advanced-env/capabilities.ts); this registry only remembers what that
// card cannot say about itself: the operation and the revision it was
// proposed against. It is registered before the card is published and removed
// the moment the card settles (allow, deny, abort, timeout, expiry), and it is
// empty after a restart. No names, values or private input are held.

export type ProposalMeta = {
  taskId: string;
  sessionId: string | null;
  /** Set when the card is joined to its persisted message; unknown at registration. */
  messageId: string | null;
  requestId: string;
  expectedRevision: string | null;
  operation: "create" | "update" | "delete";
  label: "Environment setting change";
  createdAt: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __calandriaWorkCenterProposals: Map<string, ProposalMeta> | undefined;
}

const reg = (): Map<string, ProposalMeta> => (global.__calandriaWorkCenterProposals ??= new Map());

export function registerProposal(meta: ProposalMeta): void {
  reg().set(meta.requestId, meta);
}

export function settleProposal(requestId: string): void {
  reg().delete(requestId);
}

export function getProposal(requestId: string): ProposalMeta | undefined {
  return reg().get(requestId);
}

export function listProposals(): ProposalMeta[] {
  return [...reg().values()];
}
