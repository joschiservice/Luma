import type { TenantContext } from '@luma/identity';

import type {
  PlaybookActivationView,
  PlaybookDetail,
} from '../domain/playbook-library.js';
import type { ProcessWorkflowVersion } from '../domain/process.js';
import type { presentProcessVersion } from '../domain/process-presentation.js';
import type { WorkflowReadiness } from '../domain/readiness.js';
import type { presentTriggerRun } from './trigger-presentation.js';

export type WorkflowActivationView = Omit<
  PlaybookActivationView,
  'tenantId' | 'definitionId'
>;

type WorkflowRunView = ReturnType<typeof presentTriggerRun>;

export type WorkflowDetail = Omit<
  PlaybookDetail,
  'summary' | 'versions' | 'activations'
> & {
  presentation: string;
  summary: Omit<PlaybookDetail['summary'], 'issueType'> & { category: string };
  versions: (ReturnType<typeof presentProcessVersion> &
    Pick<ProcessWorkflowVersion, 'inputs' | 'context' | 'applicability'> & {
      format: 'workflow/2';
      category: string;
    })[];
  activations: WorkflowActivationView[];
};

interface ReplenishmentRuleInput {
  id: string;
  positionId: string;
  connectionId: string;
  supplierId: string;
  minimum: number;
  target: number;
  approvalQuantity: number;
  reviewedDigest: string;
}

/** Filters one bounded page of stock choices; cursors continue the same filters. */
export interface ReplenishmentPositionQuery {
  q?: string | undefined;
  cursor?: string | undefined;
  positionId?: string | undefined;
  connectionId?: string | undefined;
}

/** @public Declaration emit names it in the inferred type of `createWorkflows`. */
export interface ReplenishmentSetup {
  available: boolean;
  canManage: boolean;
  positions: {
    positionId: string;
    connectionId: string;
    sku: string;
    unit: string;
    available: number | null;
    observedAt: string;
  }[];
  /** Continues the stock choices, independently of configured rule readiness. */
  nextCursor: string | null;
  suppliers: { id: string; name: string }[];
  rules: (Omit<ReplenishmentRuleInput, 'reviewedDigest'> & {
    active: boolean;
    principalId: string;
    sku: string;
    supplier: string;
    /** Current stock from the rule's exact source, even when it is outside the choices page. */
    stock: ReplenishmentSetup['positions'][number] | null;
    /** Whether this rule's stock can support a decision now. */
    status: {
      state: 'ready' | 'blocked' | 'revoked';
      code: string;
      message: string;
    };
    /** The run whose proposal waits for approval, if any. */
    waitingRunId: string | null;
    latestRun: ReplenishmentRunSummary | null;
  })[];
}

/** The most recent run for one stock position. */
export interface ReplenishmentRunSummary {
  runId: string;
  state: string | null;
  summary: string;
  at: string;
  /** Set once the run recorded a verification against this order. */
  purchaseOrderId: string | null;
}

/** One proposed rule in a bulk setup request, before it has an activation ID. */
type ReplenishmentPreviewItem = Omit<
  ReplenishmentRuleInput,
  'id' | 'reviewedDigest' | 'supplierId'
>;

/**
 * What activating each proposed rule would do, checked against current stock and rules.
 *
 * @public Declaration emit names it in the inferred type of `createWorkflows`.
 */
export interface ReplenishmentPreview {
  approval: WorkflowReadiness['approval'];
  supplier: { id: string; name: string };
  items: {
    positionId: string;
    connectionId: string;
    sku: string | null;
    unit: string | null;
    available: number | null;
    observedAt: string | null;
    /** `ready` activates; `covered` keeps the existing rule; others can't activate. */
    outcome: 'ready' | 'covered' | 'unavailable' | 'invalid';
    message: string;
    existingRule: {
      id: string;
      supplier: string;
      minimum: number;
      target: number;
    } | null;
    /** Whether fresh stock is already below the minimum, so a check would propose an order. */
    belowMinimum: boolean;
    proposedQuantity: number | null;
    risk: 'medium' | 'high' | null;
  }[];
}

/** The result for one rule in a bulk activation. `uncertain` items are safe to retry unchanged. */
export interface ReplenishmentBatchResult {
  id: string;
  positionId: string;
  status: 'activated' | 'failed' | 'uncertain';
  code: 'activated' | 'covered' | 'rejected' | 'uncertain';
  message: string;
  activation: WorkflowActivationView | null;
}

/**
 * How replenishment covers one stock position, with the same readiness as the workflow.
 *
 * @public Declaration emit names it in the inferred type of `createWorkflows`.
 */
export interface ReplenishmentSubjectCoverage {
  definitionId: string;
  name: string;
  purpose: string;
  canManage: boolean;
  readiness: WorkflowReadiness;
  rule: {
    id: string;
    supplier: string;
    minimum: number;
    target: number;
    approvalQuantity: number;
    active: boolean;
  } | null;
  stock: {
    sku: string;
    unit: string;
    available: number | null;
    observedAt: string;
  } | null;
  latestRun: ReplenishmentRunSummary | null;
}

/** Connects the procurement owner to the shared workflow catalog and operator commands. */
export interface ReplenishmentWorkflow {
  definitionId: string;
  detail(context: TenantContext): Promise<WorkflowDetail>;
  /** Reads a page of stock choices and readiness for every configured rule. */
  setup(
    context: TenantContext,
    query?: ReplenishmentPositionQuery,
  ): Promise<ReplenishmentSetup>;
  configure(
    context: TenantContext,
    input: ReplenishmentRuleInput,
  ): Promise<WorkflowActivationView>;
  /** Checks proposed rules against current stock and rules without changing anything. */
  preview(
    context: TenantContext,
    input: { supplierId: string; items: ReplenishmentPreviewItem[] },
  ): Promise<ReplenishmentPreview>;
  /** Activates each rule independently and reports every result. */
  configureMany(
    context: TenantContext,
    items: ReplenishmentRuleInput[],
  ): Promise<ReplenishmentBatchResult[]>;
  /** Reads readiness for one stock position. */
  coverage(
    context: TenantContext,
    positionId: string,
  ): Promise<ReplenishmentSubjectCoverage>;
  start(
    context: TenantContext,
    input: { id: string; activationId: string },
  ): Promise<WorkflowRunView>;
  revoke(
    context: TenantContext,
    id: string,
    digest: string,
  ): Promise<WorkflowActivationView>;
  review(
    context: TenantContext,
    runId: string,
  ): Promise<{
    runId: string;
    supplierId: string;
    stock: {
      available: number | null;
      unit: string | null;
      minimum: number;
      target: number;
      checkedAt: string | null;
    };
    decision: { id: string; outcome: string } | null;
    purchaseOrder: { id: string; reference: string; status: string } | null;
    verification: {
      state: 'verified' | 'failed' | 'inconclusive' | 'not_verified';
      recordedAt: string | null;
    };
    proposalId: string | null;
    decisionId: string | null;
    quantity: number | null;
    sku: string;
    supplier: string;
    state: string;
    canRespond: boolean;
  }>;
  decide(
    context: TenantContext,
    runId: string,
    input: { decisionId: string; outcome: 'approved' | 'rejected' },
  ): ReturnType<ReplenishmentWorkflow['review']>;
}
