import type { PolicyEvidence } from '../domain/action.js';

/** The audit entry recorded for a policy decision or approval response. */
interface PolicyAuditEntry {
  id: string;
  tenantId: string;
  eventKey: string;
  eventType: PolicyEvidence['type'];
  schemaVersion: 1;
  occurredAt: string;
  actor: { kind: 'user'; id: string };
  correlationId: string;
  proposalId: string;
  actionHash: string;
  policyDecisionId: string;
  evidenceRefs: string[];
  details: Record<string, string>;
}

/** Audit writer accepted by {@link policyAudit}; the audit log satisfies it structurally. */
interface PolicyAuditLog {
  append(entry: PolicyAuditEntry): Promise<void>;
}

/** Maps a policy decision or approval response to its audit entry, keyed by the evidence ID. */
function policyAuditEntry(evidence: PolicyEvidence): PolicyAuditEntry {
  const item = evidence.document;

  return {
    id: item.id,
    tenantId: item.tenantId,
    eventKey: item.id,
    eventType: evidence.type,
    schemaVersion: 1,
    occurredAt: 'evaluatedAt' in item ? item.evaluatedAt : item.createdAt,
    actor: {
      kind: 'user',
      id: 'actorId' in item ? item.actorId : item.approverId,
    },
    correlationId: item.correlationId,
    proposalId: item.proposalId,
    actionHash: item.actionHash,
    policyDecisionId: 'actorId' in item ? item.id : item.decisionId,
    evidenceRefs: [],
    details: {
      outcome: item.outcome,
      policyVersion: item.policyVersion,
      ...('reason' in item
        ? { reason: item.reason }
        : { requesterId: item.requesterId, expiresAt: item.expiresAt }),
    },
  };
}

/**
 * Returns a policy evidence writer that appends decisions and approvals to the audit log,
 * preserving their actor, proposal references, reason and approval request details.
 * Append failures propagate so the policy operation does not succeed without its audit.
 */
export function policyAudit(audit: PolicyAuditLog) {
  return async (evidence: PolicyEvidence) => {
    const entry = policyAuditEntry(evidence);
    try {
      await audit.append(entry);
    } catch (error) {
      // App-owned policy services once recorded only the outcome and policy version, and every
      // service flushes the shared outbox. A replay of evidence they already appended must still
      // be delivered, so accept it when the stored entry has that earlier shape.
      const { outcome, policyVersion } = evidence.document;
      try {
        await audit.append({ ...entry, details: { outcome, policyVersion } });
      } catch {
        throw error;
      }
    }
  };
}
