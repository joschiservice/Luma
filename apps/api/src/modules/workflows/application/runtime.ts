import type {
  DetectionRequest,
  DetectionService,
  Diagnosis,
  DiagnosisService,
} from '#modules/exceptions/index';
import type { ActionAdmission } from '#modules/execution/index';
import type { IdentityService, TenantContext } from '#modules/identity/index';
import { requireRole, requireTenant } from '#modules/identity/index';
import type { ProposedAction } from '#modules/policies/index';
import type {
  PlaybookOutcome,
  PlaybookService,
} from '#modules/workflows/application/playbook';

export type WorkflowSource = {
  kind: 'detection' | 'incident';
  id: string;
};

/** References only: payloads and authorization decisions are loaded inside activities. */
export interface ExceptionWorkflowInput {
  tenantId: string;
  userId: string;
  requestId: string;
  source: WorkflowSource;
}

export interface ProposalReference {
  id: string;
  revision: number;
  expiresAt: string;
  refreshable?: boolean;
}

export interface WorkflowProgress {
  phase:
    | 'detecting'
    | 'diagnosing'
    | 'proposing'
    | 'executing'
    | 'awaiting_approval'
    | 'reconciling'
    | 'verifying'
    | 'resolved'
    | 'no_incident'
    | 'escalated'
    | 'denied';
  exceptionId?: string;
  proposalId?: string;
  decisionId?: string;
  reason?: string;
}

export type WorkflowExecutionResult =
  | { state: 'proposal_changed'; proposal: ProposalReference }
  | { state: 'approval_required'; decisionId: string }
  | { state: 'denied' | 'succeeded' | 'failed' | 'reconciliation_required' };

export interface ExceptionActivities {
  /** Rereads current conditions and returns an immutable proposal, or null when review is needed. */
  refresh?(
    input: ExceptionWorkflowInput,
    exceptionId: string,
  ): Promise<ProposalReference | null>;
  detect(input: ExceptionWorkflowInput): Promise<string | null>;
  diagnose(
    input: ExceptionWorkflowInput,
    exceptionId: string,
  ): Promise<{
    status: Diagnosis['status'] | 'unavailable';
    revision: number;
    verificationRequired: boolean;
    retryAfter: string | null;
  }>;
  propose(
    input: ExceptionWorkflowInput,
    exceptionId: string,
    revision: number,
  ): Promise<ProposalReference | null>;
  execute(
    input: ExceptionWorkflowInput,
    exceptionId: string,
    proposal: ProposalReference,
  ): Promise<WorkflowExecutionResult>;
  reconcile(
    input: ExceptionWorkflowInput,
    proposalId: string,
  ): Promise<WorkflowExecutionResult>;
  verify(input: ExceptionWorkflowInput, exceptionId: string): Promise<boolean>;
}

export interface WorkflowBindings {
  /** Loads the latest published proposal without changing the case. */
  currentProposal?(
    context: TenantContext,
    exceptionId: string,
  ): Promise<ProposalReference | null>;
  /** Rebuilds evidence through authorized reads; preserves decisions and any business deadline. */
  refreshProposal?(
    context: TenantContext,
    exceptionId: string,
  ): Promise<ProposedAction | null>;
  recordWorkflow?(
    context: TenantContext,
    exceptionId: string,
    source: WorkflowSource,
  ): Promise<void>;
  /** Load an immutable, tenant-owned ingestion request. Never fetch live provider payloads here. */
  loadDetection(
    context: TenantContext,
    id: string,
  ): Promise<DetectionRequest | null>;
  proposals?: {
    /** Persist once per tenant, incident, revision and requester; exact replay returns the same action. */
    prepare(
      context: TenantContext,
      diagnosis: Diagnosis,
    ): Promise<ProposedAction | null>;
    get(
      context: TenantContext,
      proposalId: string,
    ): Promise<{
      exceptionId: string;
      revision: number;
      action: ProposedAction;
    } | null>;
  };
}

export class WorkflowInputError extends Error {}

/**
 * Creates workflow activities that resolve fresh tenant authorization before detection,
 * diagnosis, execution, and verification.
 */
export function createExceptionActivities(deps: {
  identity: Pick<IdentityService, 'resolveWorkflowContext'>;
  exceptions: DetectionService;
  diagnoses: DiagnosisService;
  execution: ActionAdmission;
  bindings: WorkflowBindings;
  playbook?: PlaybookService;
}): ExceptionActivities {
  async function context(input: ExceptionWorkflowInput) {
    const fresh = await deps.identity.resolveWorkflowContext(
      input.userId,
      input.tenantId,
      input.requestId,
    );
    requireTenant(fresh, input.tenantId);
    requireRole(fresh, ['owner', 'admin']);
    if (fresh.actor.id !== input.userId)
      throw new WorkflowInputError('Actor changed');

    return fresh;
  }

  async function current(
    context: TenantContext,
    exceptionId: string,
    revision: number,
  ) {
    const diagnosis = await deps.diagnoses.get(context, exceptionId);
    if (
      !diagnosis ||
      diagnosis.superseded ||
      diagnosis.status !== 'ready' ||
      diagnosis.revision !== revision
    )
      return null;

    return diagnosis;
  }

  function playbookResult(outcome: PlaybookOutcome): WorkflowExecutionResult {
    if (outcome.state === 'awaiting_approval' && outcome.decisionId)
      return { state: 'approval_required', decisionId: outcome.decisionId };
    if (outcome.state === 'verified') return { state: 'succeeded' };
    if (outcome.state === 'denied') return { state: 'denied' };

    return {
      state:
        outcome.reason === 'reconciliation_required'
          ? 'reconciliation_required'
          : 'failed',
    };
  }

  return {
    async refresh(input, exceptionId) {
      const fresh = await context(input);
      const action = await deps.bindings.refreshProposal?.(fresh, exceptionId);
      if (!action) return null;
      const stored = await deps.bindings.proposals?.get(fresh, action.id);
      if (
        !stored ||
        stored.exceptionId !== exceptionId ||
        action.proposedBy.id !== fresh.actor.id
      )
        throw new WorkflowInputError(
          'Refreshed proposal binding does not match',
        );

      return {
        id: action.id,
        revision: stored.revision,
        expiresAt: new Date(
          Math.min(
            Date.parse(action.expiresAt),
            Date.parse(action.preconditions.validUntil),
          ),
        ).toISOString(),
        refreshable: true,
      };
    },
    async detect(input) {
      const fresh = await context(input);
      if (input.source.kind === 'incident') {
        const incident = await deps.exceptions.get(fresh, input.source.id);
        if (!incident) throw new WorkflowInputError('Exception not found');
        await deps.bindings.recordWorkflow?.(fresh, incident.id, input.source);

        return incident.id;
      }
      const request = await deps.bindings.loadDetection(fresh, input.source.id);
      if (!request) throw new WorkflowInputError('Detection request not found');
      const result = await deps.exceptions.ingest(fresh, request);
      if (result.incident)
        await deps.bindings.recordWorkflow?.(
          fresh,
          result.incident.id,
          input.source,
        );

      return result.incident?.id ?? null;
    },
    async diagnose(input, exceptionId) {
      const diagnosis = await deps.diagnoses.run(
        await context(input),
        exceptionId,
      );

      return {
        status:
          !diagnosis || diagnosis.superseded ? 'unavailable' : diagnosis.status,
        revision: diagnosis?.revision ?? 0,
        verificationRequired:
          !!diagnosis &&
          !diagnosis.superseded &&
          diagnosis.detectorDecision.decision === 'clear',
        retryAfter: diagnosis?.provenance.reread.retryAfter ?? null,
      };
    },
    async propose(input, exceptionId, revision) {
      const fresh = await context(input);
      const diagnosis = await current(fresh, exceptionId, revision);
      if (!diagnosis || !deps.bindings.proposals) return null;
      const action = await deps.bindings.proposals.prepare(fresh, diagnosis);
      if (!action) return null;
      requireTenant(fresh, action.tenantId);
      if (
        action.proposedBy.kind !== 'user' ||
        action.proposedBy.id !== fresh.actor.id
      )
        throw new WorkflowInputError('Proposal requester does not match');
      const expiry = Math.min(
        Date.parse(action.expiresAt),
        Date.parse(action.preconditions.validUntil),
        diagnosis.provenance.validUntil === null
          ? Infinity
          : Date.parse(diagnosis.provenance.validUntil),
      );
      if (!Number.isFinite(expiry))
        throw new WorkflowInputError('Invalid proposal expiry');

      return {
        id: action.id,
        ...(deps.bindings.refreshProposal ? { refreshable: true } : {}),
        revision,
        expiresAt: new Date(expiry).toISOString(),
      };
    },
    async execute(input, exceptionId, proposal) {
      const fresh = await context(input);
      const latest = await deps.bindings.currentProposal?.(fresh, exceptionId);
      if (latest && latest.id !== proposal.id)
        return { state: 'proposal_changed', proposal: latest };
      if (deps.playbook) {
        const { run } = await deps.playbook.get(fresh, proposal.id);
        if (
          run.incidentId !== exceptionId ||
          run.diagnosisRevision !== proposal.revision
        )
          throw new WorkflowInputError('Playbook run binding does not match');

        return playbookResult(await deps.playbook.execute(fresh, proposal.id));
      }
      const previous = await deps.execution.get(fresh, proposal.id);
      if (previous && 'record' in previous) return { state: previous.state };
      const stored = await deps.bindings.proposals?.get(fresh, proposal.id);
      if (
        !stored ||
        stored.exceptionId !== exceptionId ||
        stored.revision !== proposal.revision ||
        stored.action.id !== proposal.id
      )
        throw new WorkflowInputError('Proposal binding does not match');
      if (!(await current(fresh, exceptionId, proposal.revision)))
        return { state: 'denied' };
      const result = await deps.execution.execute(fresh, {
        runId: stored.action.id,
        stepId: 'execute',
      });

      return result.state === 'approval_required'
        ? { state: result.state, decisionId: result.decision.id }
        : { state: result.state };
    },
    async reconcile(input, proposalId) {
      if (deps.playbook)
        return playbookResult(
          await deps.playbook.reconcile(await context(input), proposalId),
        );
      const result = await deps.execution.reconcile(
        await context(input),
        proposalId,
      );
      if (result.state === 'approval_required')
        throw new WorkflowInputError('Unexpected reconciliation result');

      return { state: result.state };
    },
    async verify(input, exceptionId) {
      const fresh = await context(input);
      const incident = await deps.exceptions.get(fresh, exceptionId);
      if (!incident) throw new WorkflowInputError('Exception not found');
      // A worker may have committed the resolution before its activity completion was recorded.
      if (incident.state === 'resolved')
        return incident.resolution?.kind === 'verification';

      return deps.exceptions.verify(fresh, exceptionId);
    },
  };
}
