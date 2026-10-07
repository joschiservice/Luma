import type {
  DraftTestCase,
  ProcessWorkflowVersion,
  StepReply,
  TestOutcome,
  TestScenario,
  TestScenarioSource,
  WorkflowDraftContent,
} from '@luma/workflows';
import { adaptCase, defaultCase, sameStep } from '@luma/workflows';

type Replies = Record<string, StepReply>;

// Stock 10 below a minimum of 20 with a target of 60 proposes 50 units, as in the simulator matrix.
const stock = {
  kind: 'read',
  values: { fresh: true, available: 10, sku: 'SKU-100', unit: 'pcs' },
} as const;
const staleStock = { ...stock, values: { ...stock.values, fresh: false } };
const proposal = {
  kind: 'read',
  values: {
    eligible: true,
    committed: false,
    quantity: 50,
    approvalRequired: false,
    supplier: 'Example supplier',
  },
} as const;
const covered = {
  ...proposal,
  values: { ...proposal.values, eligible: false, committed: true, quantity: 0 },
};
const draftOrder = {
  kind: 'verification',
  state: 'verified',
  values: { purchaseOrderId: 'example-order', quantity: 50, status: 'draft' },
} as const;
const changedOrder = {
  ...draftOrder,
  state: 'failed',
  values: { ...draftOrder.values, status: 'unverified' },
} as const;
const action = (
  result: Extract<StepReply, { kind: 'capability' }>['result'],
): StepReply => ({ kind: 'capability', result });

const matrix: {
  id: string;
  name: string;
  description: string;
  outcome: TestOutcome;
  replies: Replies;
}[] = [
  {
    id: 'approval-pending',
    name: 'Waits for approval',
    description:
      'Stock is below the minimum and policy asks someone else who can approve changes to approve the purchase-order draft. The run waits for that decision.',
    outcome: 'awaiting_decision',
    replies: {
      inventory: stock,
      proposal,
      'create-order': action('approval_required'),
      'verify-order': draftOrder,
    },
  },
  {
    id: 'approved-verified',
    name: 'Approved and verified',
    description:
      'The proposal is approved, the purchase-order draft is created and the result check confirms it.',
    outcome: 'verified',
    replies: {
      inventory: stock,
      proposal,
      'create-order': action('accepted'),
      'verify-order': draftOrder,
    },
  },
  {
    id: 'policy-rejected',
    name: 'Policy rejection',
    description:
      'The approver rejects the proposal. No purchase-order draft is created and the run goes to a person.',
    outcome: 'escalated',
    replies: {
      inventory: stock,
      proposal,
      'create-order': action('denied'),
      'verify-order': draftOrder,
    },
  },
  {
    id: 'stale-inventory',
    name: 'Stale stock',
    description:
      'Stock data is older than five minutes, so the run stops for review before proposing an order.',
    outcome: 'escalated',
    replies: {
      inventory: staleStock,
      proposal,
      'create-order': action('accepted'),
      'verify-order': draftOrder,
    },
  },
  {
    id: 'existing-order',
    name: 'Existing purchase order',
    description:
      'A draft or open purchase order already covers the SKU, so the run finishes without a new order.',
    outcome: 'ended',
    replies: {
      inventory: stock,
      proposal: covered,
      'create-order': action('accepted'),
      'verify-order': draftOrder,
    },
  },
  {
    id: 'verification-failed',
    name: 'Verification failure',
    description:
      'The purchase-order draft changes before the result check, so verification fails and the run needs review.',
    outcome: 'failed_verification',
    replies: {
      inventory: stock,
      proposal,
      'create-order': action('accepted'),
      'verify-order': changedOrder,
    },
  },
];

/**
 * Offers the replenishment simulator scenarios as test cases. Replies are keyed by the reference
 * step IDs and applied to any draft step with the same read source, action or result check, so
 * customized copies of the template get them too.
 */
export function createReplenishmentScenarios(
  version: ProcessWorkflowVersion,
): TestScenarioSource {
  const referenced = version.steps.filter((step) =>
    matrix.some((scenario) => Object.hasOwn(scenario.replies, step.id)),
  );

  return {
    scenarios(content: WorkflowDraftContent): TestScenario[] {
      if (
        !content.steps.some((step) =>
          referenced.some((reference) => sameStep(step, reference)),
        )
      )
        return [];
      const base = defaultCase(content, '00000000-0000-4000-8000-000000000000');

      return matrix.map((scenario) => {
        const example: DraftTestCase = adaptCase(
          content,
          version,
          {
            inputs: { activationId: 'example-rule' },
            evidence: { belowMinimum: true },
            replies: scenario.replies,
          },
          { ...base, name: scenario.name },
        );

        return {
          id: scenario.id,
          name: scenario.name,
          description: scenario.description,
          case: { ...example, expected: { outcome: scenario.outcome } },
        };
      });
    },
  };
}
