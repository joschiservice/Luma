import type {
  PlaybookFields,
  PlaybookIR,
  PlaybookScalar,
  PlaybookSnapshot,
  PlaybookVersion,
} from './playbook.js';
import type { ProcessWorkflowVersion } from './process.js';

/** Identifies the accountable caller; an agent also needs a verified delegation grant. */
export type WorkflowActor =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string; operatorId: string; grantId: string };

/** Describes the initiating signal without requiring a case or diagnosis. */
export type WorkflowTrigger =
  | { kind: 'exception'; issueType: string }
  | { kind: 'manual' }
  | { kind: 'event'; eventType: string }
  | { kind: 'schedule'; at: string }
  | { kind: 'condition'; field: string; equals: PlaybookScalar };

export interface WorkflowDefinition {
  id: string;
  name: string;
  intent: string;
  category: string;
}

/** An immutable definition of inputs, applicability, decisions, effects and verification. */
export interface WorkflowSource {
  schemaVersion: 1;
  definition: WorkflowDefinition;
  version: string;
  applicability: { trigger: WorkflowTrigger; subjectKind: string };
  inputs: PlaybookFields;
  context: PlaybookIR['evidence'];
  steps: [
    PlaybookIR['eligibility'],
    PlaybookIR['action'],
    PlaybookIR['approval'],
    PlaybookIR['verification'],
    PlaybookIR['recovery'],
  ];
  policy: {
    approval: 'policy' | 'required';
    minimumRisk: 'low' | 'medium' | 'high';
  };
  outcome: {
    kind: 'verified_postcondition';
    evaluatorVersion: string;
    onUnverified: 'escalate';
  };
  provenance: PlaybookVersion['provenance'];
}

export interface WorkflowVersion extends WorkflowSource {
  digest: string;
  /** Identifies the representation covered by the digest; legacy hashes remain unchanged. */
  format: 'workflow/1' | 'resolution-playbook/0';
}

/** Native versions can use either the original Resolution-shaped contract or the process runtime. */
export type PublishedWorkflowVersion = WorkflowVersion | ProcessWorkflowVersion;

/** A run binds an exact version, subject, actor and immutable input snapshot. */
/** Immutable trigger configuration bound to a published process; updates add revisions. */
export interface WorkflowSubscription {
  id: string;
  definitionId: string;
  version: string;
  versionDigest: string;
  revision: number;
  trigger: WorkflowTrigger;
  active: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface WorkflowRun {
  subscription?: WorkflowSubscription | undefined;
  id: string;
  tenantId: string;
  definitionId: string;
  version: string;
  versionDigest: string;
  activationId: string | null;
  artifactDigest: string | null;
  trigger: WorkflowTrigger;
  subject: { kind: string; id: string };
  actor: WorkflowActor;
  context: PlaybookSnapshot;
  contextDigest: string;
  createdAt: string;
  resolution?: { incidentId: string; diagnosisRevision: number };
}

/** Projects the existing executable representation without changing its signed content. */
export function resolutionWorkflow(version: PlaybookVersion): WorkflowVersion {
  const ir = version.ir;

  return {
    schemaVersion: 1,
    definition: { ...version.definition, category: 'resolution' },
    version: version.version,
    digest: version.digest,
    format: 'resolution-playbook/0',
    applicability: {
      trigger: { kind: 'exception', issueType: ir.evidence.kind },
      subjectKind: ir.action.targetKind,
    },
    inputs: ir.inputs,
    context: ir.evidence,
    steps: [
      ir.eligibility,
      ir.action,
      ir.approval,
      ir.verification,
      ir.recovery,
    ],
    policy: { approval: ir.approval.mode, minimumRisk: ir.action.minimumRisk },
    outcome: {
      kind: 'verified_postcondition',
      evaluatorVersion: ir.verification.evaluatorVersion,
      onUnverified: 'escalate',
    },
    provenance: version.provenance,
  };
}

/** A trigger creates a run without granting permission to dispatch an action. */
export interface WorkflowTriggerRun extends WorkflowRun {
  evidence: { sourceId: string; occurredAt: string };
  requestDigest: string;
  createdAt: string;
  /** `skipped`: the scheduled time came while the workspace was suspended or closed. */
  state: 'scheduled' | 'awaiting_admission' | 'cancelled' | 'skipped';
  triggeredAt: string | null;
}

/** Supplies a version-bound signal and explicit resource; the caller identity comes from authentication. */
export interface WorkflowTriggerRequest {
  subscription?: { id: string; revision: number } | undefined;
  version: string;
  reviewedDigest: string;
  subject: { kind: string; id: string };
  signal: {
    kind: WorkflowTrigger['kind'];
    sourceId: string;
    occurredAt: string;
  };
  context: PlaybookSnapshot;
}
