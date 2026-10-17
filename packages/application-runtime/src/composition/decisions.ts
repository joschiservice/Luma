import type { createAdaptiveFieldWorkflows } from '@luma/adaptive/composition';
import { caseDecisionQuery } from '@luma/exceptions/composition';
import { hasPermission, type IdentityService } from '@luma/identity';
import type { createMessaging } from '@luma/messaging/composition';
import type { ReturnCases, ReturnDeadlines } from '@luma/orders/composition';
import type { TenantDatabase } from '@luma/platform';
import { notFound } from '@luma/platform';
import type {
  createPurchaseOrderChanges,
  createPurchasing,
  SupplierCommitments,
} from '@luma/procurement/composition';
import type { DecisionAssignments, DecisionQueue } from '@luma/read-models';
import {
  appDecisionProvider,
  createDecisionQueue,
  customFieldDecisionProvider,
  governedFollowUpDecisionProvider,
  humanTaskDecisionProvider,
  messageReplyDecisionProvider,
  nativeReceiptDecision,
  procurementActionDecisionProvider,
  replenishmentDecisionProvider,
  replySendDecisionProvider,
  returnCaseDecisionProvider,
  supplierCommitmentDecisionProvider,
  workflowHandoverDecisionProvider,
} from '@luma/read-models/composition';
import { createDecisionAssignments } from '@luma/resolution/composition';
import type { createCoordination } from '@luma/workflows/composition';

import type { createCaseWorkflowServices } from './case-workflows.js';
import type { createNativeStockRuntime } from './native-stock.js';
import type { createReplenishmentRuntime } from './replenishment.js';
import type { createScopedSupplierFollowUp } from './scoped-follow-up.js';
import type { createDetectionServices } from './services.js';

/** The owners whose pending work Needs you lists. */
export interface DecisionOwners {
  adaptiveFieldWorkflows: ReturnType<typeof createAdaptiveFieldWorkflows>;
  /** Installed-app decision sources. */
  apps: Parameters<typeof appDecisionProvider>[0][];
  cases: ReturnType<typeof createDetectionServices>['cases'];
  caseWorkflows: ReturnType<typeof createCaseWorkflowServices>;
  commitments: SupplierCommitments;
  coordination: ReturnType<typeof createCoordination>;
  messaging: ReturnType<typeof createMessaging>;
  nativeStock: ReturnType<typeof createNativeStockRuntime>;
  orderChanges: ReturnType<typeof createPurchaseOrderChanges>;
  purchasing: ReturnType<typeof createPurchasing>;
  replenishment: ReturnType<typeof createReplenishmentRuntime>;
  returnCases: ReturnCases;
  returnDeadlines: ReturnDeadlines;
  scopedFollowUp: ReturnType<typeof createScopedSupplierFollowUp>;
}

/**
 * Builds the Needs you queue over every owner's pending work, and assignment of its decisions.
 * A case decision is assigned through the case's own revision-checked owner command; other
 * decisions are assigned in the queue. `diffEnabled` gates action diffs per tenant.
 */
export function createDecisionServices(
  database: TenantDatabase,
  identity: IdentityService,
  owners: DecisionOwners,
  diffEnabled: (tenantId: string) => Promise<boolean>,
): { assignments: DecisionAssignments; decisions: DecisionQueue } {
  const decisions = createDecisionQueue(database, {
    diffEnabled,
    cases: caseDecisionQuery,
    providers: [
      governedFollowUpDecisionProvider(
        database,
        owners.scopedFollowUp.service.pending,
      ),
      customFieldDecisionProvider((context) =>
        owners.adaptiveFieldWorkflows.pending(context),
      ),
      humanTaskDecisionProvider((context) =>
        owners.coordination.pending(context),
      ),
      replenishmentDecisionProvider(owners.replenishment.pending),
      procurementActionDecisionProvider(async (context) => {
        const plans = (await owners.purchasing.plans(context)).items.filter(
          (p) =>
            ['approval_required', 'approved', 'uncertain'].includes(p.state),
        );
        const revisions = await owners.orderChanges.pending(context);
        const receipts = hasPermission(context, 'inventory.read')
          ? await owners.nativeStock.ledger.pendingPurchaseReceipts(context)
          : [];

        return [
          ...plans.map((p) => ({
            id: p.id,
            kind: 'plan' as const,
            orderId: null,
            reference: p.order.reference,
            state: p.state as 'approval_required' | 'approved' | 'uncertain',
            requestedBy: p.requestedBy,
            requestedAt: p.createdAt,
            expiresAt: p.expiresAt,
            canApprove: p.canApprove ?? false,
            quantity: p.order.lines.reduce((sum, l) => sum + l.quantity, 0),
          })),
          ...revisions,
          ...receipts.map((r) => nativeReceiptDecision(context, r)),
        ];
      }),
      returnCaseDecisionProvider(async (context) => {
        const [cases, waits] = await Promise.all([
          owners.returnCases.pending(context),
          owners.returnDeadlines.pending(context),
        ]);

        return cases.map((value) => {
          const waiting = waits.find((w) => w.caseId === value.case.id);

          return waiting ? { ...value, waiting } : value;
        });
      }),
      supplierCommitmentDecisionProvider(async (context) =>
        (await owners.commitments.pending(context)).map((item) => ({
          key: item.attention.key,
          submissionId: item.submission?.id,
          channel: item.submission?.channel,
          kind: item.attention.kind,
          purchaseOrderId: item.order.id,
          reference: item.order.reference,
          supplierName: item.supplierName,
          summary: item.attention.summary,
          dueAt: item.attention.dueAt,
          expiresAt:
            item.attention.kind === 'submission_approval'
              ? (item.submission?.expiresAt ?? null)
              : null,
          requesterId: item.submission?.requestedBy ?? null,
          canRespond: item.canRespond,
          observeOnly: item.submission?.observeOnly ?? false,
          requestedDeliveryDate: item.submission?.requestedDeliveryDate ?? null,
          // Descriptions read better than canonical SKU keys in a decision.
          lines: item.order.lines.map((l) => ({
            sku: l.description,
            quantity: l.quantity,
            unit: l.unit,
          })),
          line: item.line
            ? {
                sku: item.line.description,
                quantity: item.line.quantity,
                unit: item.line.unit,
              }
            : null,
          evidenceRefs: [
            ...(item.submission
              ? [item.submission.id, item.submission.decisionId]
              : []),
            ...(item.commitment
              ? [
                  item.commitment.id,
                  ...(item.commitment.source.kind === 'purchasing_system'
                    ? [item.commitment.source.observationId]
                    : item.commitment.source.kind === 'communication'
                      ? [item.commitment.source.communicationId]
                      : item.commitment.source.kind === 'manual_receipt'
                        ? item.commitment.source.evidence
                        : []),
                ]
              : []),
          ].filter((ref): ref is string => !!ref),
          commitment: item.commitment
            ? {
                kind: item.commitment.kind,
                quantity: item.commitment.quantity,
                date: item.commitment.date,
                text: item.commitment.text,
                reasons: item.commitment.reviewReasons,
              }
            : null,
        })),
      ),
      workflowHandoverDecisionProvider(async (context) =>
        (await owners.caseWorkflows.handovers(context)).map((item) => ({
          definitionId: item.definitionId,
          name: item.name,
          runId: item.runId,
          handedOverAt: item.handedOverAt,
          title: item.signal.title,
          detail: item.signal.detail,
          domain: item.signal.domain,
          record: item.signal.record,
        })),
      ),
      messageReplyDecisionProvider(async (context) =>
        (await owners.messaging.service.dueReplies(context)).map((item) => ({
          threadId: item.threadId,
          subject: item.subject,
          correspondent: item.correspondent?.name
            ? `${item.correspondent.name} <${item.correspondent.address}>`
            : (item.correspondent?.address ?? null),
          mailboxLabel: item.mailboxLabel,
          replyDueAt: item.replyDueAt,
          receivedAt: item.lastInboundAt ?? item.lastMessageAt,
          canRespond: item.canRespond,
        })),
      ),
      replySendDecisionProvider((context) =>
        owners.messaging.replies.pending(context),
      ),
      ...owners.apps.map(appDecisionProvider),
    ],
    refreshContext: identity.refreshContext,
  });
  const queueAssignments = createDecisionAssignments(database, {
    refreshContext: identity.refreshContext,
    members: async (context) =>
      (await identity.listMembers(context)).map((member) => member.userId),
    pending: async (context, id) => {
      const item = await decisions.find(context, id);
      if (item?.outcome) return false;

      // Return case assignments belong to the case's revision-checked command.
      return (
        !!item &&
        item.owner.kind !== 'return_case' &&
        item.owner.kind !== 'case'
      );
    },
  });
  const assignments: DecisionAssignments = {
    async assign(context, input) {
      if (!input.decisionId.startsWith('case:'))
        return queueAssignments.assign(context, input);
      const item = await decisions.find(context, input.decisionId);
      if (!item || item.outcome || item.owner.kind !== 'case')
        throw notFound('This decision no longer needs a person.');
      const owner = await owners.cases.assignOwner(
        context,
        item.owner.exceptionId,
        { userId: input.assigneeId, revision: input.revision },
      );

      return {
        decisionId: input.decisionId,
        assignment: {
          assigneeId: owner.userId,
          assignedBy: owner.assignedBy,
          assignedAt: owner.assignedAt,
          revision: owner.revision,
        },
      };
    },
  };

  return { assignments, decisions };
}
