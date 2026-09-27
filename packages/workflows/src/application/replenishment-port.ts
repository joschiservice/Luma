import type { TenantContext } from '@luma/identity';

import type {
  PlaybookActivationView,
  PlaybookDetail,
} from '../domain/playbook-library.js';
import type { ProcessWorkflowVersion } from '../domain/process.js';
import type { presentProcessVersion } from '../domain/process-presentation.js';
import type { presentTriggerRun } from './trigger-presentation.js';

export type WorkflowActivationView = Omit<
  PlaybookActivationView,
  'tenantId' | 'definitionId'
>;

export type WorkflowRunView = ReturnType<typeof presentTriggerRun>;

export type WorkflowDetail = Omit<
  PlaybookDetail,
  'summary' | 'versions' | 'activations'
> & {
  summary: Omit<PlaybookDetail['summary'], 'issueType'> & { category: string };
  versions: (ReturnType<typeof presentProcessVersion> &
    Pick<ProcessWorkflowVersion, 'inputs' | 'context' | 'applicability'> & {
      format: 'workflow/2';
      category: string;
    })[];
  activations: WorkflowActivationView[];
};

export interface ReplenishmentRuleInput {
  id: string;
  positionId: string;
  connectionId: string;
  supplierId: string;
  minimum: number;
  target: number;
  approvalQuantity: number;
  reviewedDigest: string;
}

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
  suppliers: { id: string; name: string }[];
  rules: (Omit<ReplenishmentRuleInput, 'reviewedDigest'> & {
    active: boolean;
    principalId: string;
    sku: string;
    supplier: string;
  })[];
}

/** Connects the procurement owner to the shared workflow catalog and operator commands. */
export interface ReplenishmentWorkflow {
  definitionId: string;
  detail(context: TenantContext): Promise<WorkflowDetail>;
  setup(context: TenantContext): Promise<ReplenishmentSetup>;
  configure(
    context: TenantContext,
    input: ReplenishmentRuleInput,
  ): Promise<WorkflowActivationView>;
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
