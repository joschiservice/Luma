import type { TenantContext } from '#modules/identity/index';

export interface EffectIntent {
  tenantId: string;
  connectionId: string;
  capability: string;
  capabilityVersion: string;
  target: { kind: string; id: string };
  parameters: Record<string, string | number | boolean | null>;
  preconditions: { evidenceRefs: string[]; validUntil: string };
  expectedPostcondition: Record<string, string | number | boolean | null>;
}
export interface VerificationResult {
  outcome: 'passed' | 'failed' | 'inconclusive';
  observationRefs: string[];
  observedAt: string;
  evaluatorVersion: string;
}
/** Resolved by trusted composition for an active, tenant-owned connection. */
export interface EffectAdapter {
  /** Stable provider and adapter identity, pinned across dispatch and reconciliation. */
  dispatchIdentity?: string;
  capability: string;
  version: string;
  minimumRisk: 'low' | 'medium' | 'high';
  mechanism:
    | 'api'
    | 'deterministic_browser'
    | 'agentic_browser'
    | 'human'
    | 'sandboxed_code';
  executor: {
    kind: 'service' | 'agent' | 'connector';
    id: string;
    model?: {
      provider: string;
      name: string;
      version: string;
      promptVersion: string;
      runId: string;
    };
  };
  checkPreconditions(intent: EffectIntent): Promise<boolean>;
  execute(
    intent: EffectIntent,
    idempotencyKey: string,
  ): Promise<{ evidenceRefs: string[]; providerRequestId?: string | null }>;
  /** Read authoritative state; never perform a write during verification. */
  verify(intent: EffectIntent): Promise<VerificationResult>;
}
export interface EffectRegistry {
  resolve(
    context: TenantContext,
    intent: EffectIntent,
  ): Promise<EffectAdapter | null>;
}
