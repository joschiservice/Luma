import type { CodeStep, CodeTelemetry } from './code-step.js';
import type {
  PlaybookFields,
  PlaybookScalar,
  PlaybookSnapshot,
  PlaybookValue,
} from './playbook.js';
import type {
  WorkflowActor,
  WorkflowDefinition,
  WorkflowTrigger,
} from './workflow.js';

/** A bounded, forward-only instruction. Every ID remains stable across a published version. */
export type ProcessStep =
  | CodeStep
  | { id: string; kind: 'read'; source: string; fields: PlaybookFields }
  | {
      id: string;
      kind: 'condition';
      field: string;
      equals: PlaybookScalar;
      onFalse: 'escalate' | 'end';
    }
  | {
      id: string;
      kind: 'capability';
      capability: string;
      capabilityVersion: string;
      targetKind: string;
      minimumRisk: 'low' | 'medium' | 'high';
      parameters: Record<string, ProcessValue>;
      expectedPostcondition: Record<string, ProcessValue>;
    }
  | {
      id: string;
      kind: 'approval';
      forStep: string;
      expiresAfterSeconds: number;
    }
  | { id: string; kind: 'wait'; seconds: number }
  | {
      id: string;
      kind: 'human_task';
      assignee: TaskAssignee;
      instructions: string;
      choices: string[];
      evidence: 'text' | 'link' | 'record';
      dueAfterSeconds: number;
      escalationTarget: TaskAssignee;
    }
  | {
      id: string;
      kind: 'event_wait';
      eventType: string;
      correlation: ProcessValue;
      fields: PlaybookFields;
      timeoutSeconds: number;
      onTimeout: 'escalate' | 'end';
    }
  | {
      id: string;
      kind: 'verification';
      forStep: string;
      evaluatorVersion: string;
      maxDurationSeconds: number;
      fields: PlaybookFields;
      recheck?: { attempts: number; intervalSeconds: number } | undefined;
    }
  | { id: string; kind: 'escalation'; reason: string }
  | { id: string; kind: 'end'; outcome: string };

/** Values may use an earlier typed read, immutable input, evidence, or a literal. */
export type ProcessValue =
  PlaybookValue | { source: 'step'; stepId: string; field: string };

/** Published process versions are immutable and cannot execute arbitrary source code. */
export interface ProcessWorkflowVersion {
  schemaVersion: 2;
  format: 'workflow/2';
  definition: WorkflowDefinition;
  version: string;
  digest: string;
  applicability: { trigger: WorkflowTrigger; subjectKind: string };
  inputs: PlaybookFields;
  context: { kind: string; fields: PlaybookFields; maxAgeSeconds: number };
  steps: ProcessStep[];
  provenance: {
    kind: 'resolution' | 'pilot' | 'native';
    reference: string;
    authoredBy: string;
    evidenceRefs: string[];
    /** Present on versions published from a draft: the mode, draft revision and version notes. */
    authoring?:
      | {
          mode: 'template' | 'visual' | 'code' | 'language';
          draftId: string;
          revision: number;
          notes?: string | undefined;
        }
      | undefined;
  };
}

/** A process run records progress independently from each action's dispatch and outcome. */
export interface ProcessRun {
  id: string;
  tenantId: string;
  definitionId: string;
  version: string;
  versionDigest: string;
  subject: { kind: string; id: string };
  actor: WorkflowActor;
  context: PlaybookSnapshot;
  contextDigest: string;
  createdAt: string;
}

/** Typed evidence from one step; references point to the authoritative source or receipt. */
export interface ProcessStepOutput {
  stepId: string;
  kind: ProcessStep['kind'];
  state:
    | 'not_executed'
    | 'completed'
    | 'waiting'
    | 'denied'
    | 'failed'
    | 'inconclusive'
    | 'ended'
    | 'escalated';
  values: Record<string, PlaybookScalar>;
  evidenceRefs: string[];
  observedAt?: string;
  recordedAt: string;
  reason?: string;
  code?: CodeTelemetry;
}

export type ProcessRunState =
  | 'not_executed'
  | 'running'
  | 'awaiting_decision'
  | 'waiting'
  | 'verified'
  | 'ended'
  | 'denied'
  | 'failed_verification'
  | 'inconclusive_verification'
  | 'escalated';

/** A current workspace member or a role; assignment never grants action authority. */
export type TaskAssignee =
  { kind: 'person'; id: string } | { kind: 'role'; key: string };

/** Human evidence is input to later steps, never verification of a provider effect. */
export interface HumanTaskAnswer {
  choice: string;
  note?: string | undefined;
  evidence: { kind: 'text' | 'link' | 'record'; value: string };
}
