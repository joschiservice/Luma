export interface AuditActor {
  kind: 'user' | 'service' | 'agent' | 'connector';
  id: string;
  initiatingUserId?: string;
  model?: {
    provider: string;
    name: string;
    version: string;
    promptVersion: string;
    runId: string;
  };
}
export interface AuditEntry {
  id: string;
  tenantId: string;
  eventKey: string;
  eventType: string;
  schemaVersion: 1;
  occurredAt: string;
  actor: AuditActor;
  proposedBy?: AuditActor;
  executor?: AuditActor;
  correlationId: string;
  proposalId: string;
  actionHash: string;
  policyDecisionId?: string;
  attemptId?: string;
  connectionId?: string;
  evidenceRefs: string[];
  details: Record<string, string>;
}
export interface AuditLog {
  /** Exact replay is accepted; reuse of an event key with different content fails. */
  append(entry: AuditEntry): Promise<void>;
  list(tenantId: string, proposalId: string): Promise<AuditEntry[]>;
}
