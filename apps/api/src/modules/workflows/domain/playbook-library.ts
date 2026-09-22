import type { PlaybookActivation } from '#modules/workflows/domain/playbook';
import type { presentPlaybook } from '#modules/workflows/domain/playbook-presentation';

export interface ActivatePlaybook {
  id: string;
  version: string;
  reviewedDigest: string;
  policyVersion: string;
  connectionId: string;
  connectionVersion: number;
  targetIds: string[];
  scopeReviewed: true;
}

export interface PlaybookActivationView extends PlaybookActivation {
  active: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface PlaybookSummary {
  id: string;
  name: string;
  purpose: string;
  capability: string;
  issueType: string;
  systems: string[];
  availableVersion: string;
  status: 'active' | 'inactive' | 'revoked' | 'unavailable';
  blockers: string[];
  activeVersions: string[];
}

export interface PlaybookDetail {
  summary: PlaybookSummary;
  versions: ReturnType<typeof presentPlaybook>[];
  connections: {
    id: string;
    label: string;
    system: string;
    version: number;
    blockers: string[];
    targets: { id: string; label: string }[];
  }[];
  activations: PlaybookActivationView[];
  policyVersion: string;
  principalId: string;
  canManage: boolean;
  evaluationEvidence: 'unavailable';
}

export interface PlaybookRunView {
  id: string;
  incidentId: string;
  createdAt: string;
  version: string;
  versionDigest: string;
  activationId: string;
  evidenceKind: 'pilot' | 'live' | 'simulation' | 'shadow' | 'unclassified';
  execution: string;
  verification: string;
  reason: string;
}
