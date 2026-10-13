import type { TenantContext } from '@luma/identity';
import type { ReturnCaseAttention } from '@luma/orders';

import type {
  AppOwnedDecision,
  DecisionProvider,
  ReplenishmentDecisionReader,
  SupplierCommitmentDecisionReader,
} from '../../application/decisions.js';
import {
  type MessageReplyDecision,
  presentMessageReply,
  presentReplenishment,
  presentSupplierCommitment,
  presentWorkflowHandover,
  type WorkflowHandoverDecision,
} from '../../domain/decisions.js';
import {
  presentReplySend,
  type ReplySendDecision,
} from '../../domain/reply-decisions.js';
import { presentReturnCase } from '../../domain/return-case-decisions.js';

/** Contributes persisted return work and creation approvals without provider reads. */
export function returnCaseDecisionProvider(
  pending: (context: TenantContext) => Promise<ReturnCaseAttention[]>,
): DecisionProvider {
  return {
    id: 'return-cases',
    label: 'Returns',
    permission: 'returns.read',
    pending: async (context) =>
      (await pending(context)).map((item) => presentReturnCase(item)),
  };
}

/** Adapts the procurement owner's pending purchase-order proposals to the queue. */
export function replenishmentDecisionProvider(
  pending: ReplenishmentDecisionReader,
): DecisionProvider {
  return {
    id: 'replenishment',
    label: 'Replenishment',
    permission: 'procurement.read',
    pending: async (context) =>
      (await pending(context)).map((item) => ({
        ...presentReplenishment(item, context.actor.id),
        actionReference: { runId: item.runId, stepId: 'create-order' },
      })),
  };
}

/** Adapts an app's decisions. The app ID lets the host mount the app's own review. */
export function appDecisionProvider(app: {
  appId: string;
  name: string;
  decisions(context: TenantContext): Promise<AppOwnedDecision[]>;
}): DecisionProvider {
  return {
    id: `app:${app.appId}`,
    label: app.name,
    pending: async (context) =>
      (await app.decisions(context)).map((item) => ({
        ...item,
        owner: { ...item.owner, appId: app.appId },
      })),
  };
}

/** Adapts the procurement owner's supplier-lifecycle items to the queue. */
export function supplierCommitmentDecisionProvider(
  pending: SupplierCommitmentDecisionReader,
): DecisionProvider {
  return {
    id: 'supplier-commitments',
    label: 'Supplier orders',
    permission: 'procurement.read',
    pending: async (context) =>
      (await pending(context)).map((item) =>
        presentSupplierCommitment(item, context.actor.id),
      ),
  };
}

/** Adapts workflow runs that handed an owner's follow-up to a person. */
export function workflowHandoverDecisionProvider(
  pending: (context: TenantContext) => Promise<WorkflowHandoverDecision[]>,
): DecisionProvider {
  return {
    id: 'workflow-handovers',
    label: 'Workflow follow-ups',
    pending: async (context) =>
      (await pending(context)).map(presentWorkflowHandover),
  };
}

/** Adapts the messaging owner's due replies to the queue. */
export function messageReplyDecisionProvider(
  pending: (context: TenantContext) => Promise<MessageReplyDecision[]>,
): DecisionProvider {
  return {
    id: 'message-replies',
    label: 'Inbox',
    permission: 'messages.read',
    pending: async (context) =>
      (await pending(context)).map(presentMessageReply),
  };
}

/** Adapts the messaging owner's replies awaiting approval, sending or a check to the queue. */
export function replySendDecisionProvider(
  pending: (context: TenantContext) => Promise<ReplySendDecision[]>,
): DecisionProvider {
  return {
    id: 'message-sends',
    label: 'Replies',
    permission: 'messages.read',
    pending: async (context) => (await pending(context)).map(presentReplySend),
  };
}
