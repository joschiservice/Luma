import type { AutonomyAdmission, AutonomyBlock } from './scoped-autonomy.js';

export const currentPolicyVersion = 'v0.1';

export interface Provenance {
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

/** Immutable intent. Changes require a new proposal ID and approval. */
export interface ProposedAction {
  schemaVersion: 1;
  id: string;
  tenantId: string;
  capability: string;
  capabilityVersion: string;
  connectionId: string;
  target: { kind: string; id: string };
  parameters: Record<string, string | number | boolean | null>;
  preconditions: { evidenceRefs: string[]; validUntil: string };
  expectedPostcondition: Record<string, string | number | boolean | null>;
  risk: 'low' | 'medium' | 'high';
  proposedBy: Provenance;
  expiresAt: string;
}

export interface PolicyDecision {
  correlationId: string;
  id: string;
  tenantId: string;
  proposalId: string;
  actionHash: string;
  actorId: string;
  capability: string;
  policyVersion: string;
  outcome: 'allowed' | 'denied' | 'approval_required';
  reason:
    | 'authorized'
    | 'permission_denied'
    | 'capability_unavailable'
    | 'stale_intent'
    | 'approval_required'
    | 'approval_rejected'
    | 'scoped_autonomy'
    | 'covered_approval';
  /** Trusted bounded-delegation facts; never provided by the caller or a model. */
  autonomy?: AutonomyAdmission;
  autonomyBlock?: AutonomyBlock;
  approvalId?: string;
  /** The permission the actor needed; approvers also need it when it belongs to an app. */
  permission?: string;
  evaluatedAt: string;
  validUntil: string;
}

export interface Approval {
  decisionId: string;
  correlationId: string;
  id: string;
  tenantId: string;
  proposalId: string;
  actionHash: string;
  policyVersion: string;
  requesterId: string;
  approverId: string;
  outcome: 'approved' | 'rejected';
  expiresAt: string;
  createdAt: string;
}

export type PolicyEvidence =
  | { type: 'policy.evaluated'; document: PolicyDecision }
  | { type: 'approval.responded'; document: Approval };

/** Binds decisions to the platform version, workspace revision and effective independent approval rule. */
export function workspacePolicyVersion(
  revision: number,
  requireIndependentApproval = true,
  autonomyRevision = 0,
): string {
  const version =
    revision === 0
      ? currentPolicyVersion
      : `${currentPolicyVersion}:workspace:${revision}`;

  const effective = requireIndependentApproval
    ? version
    : `${version}:self-approval`;

  return autonomyRevision
    ? `${effective}:autonomy:${autonomyRevision}`
    : effective;
}
