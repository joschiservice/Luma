import type { TenantContext } from '@luma/identity';
import { hasPermission } from '@luma/identity';
import { conflict, notFound, unavailable } from '@luma/platform';

import type { Attention, Commitment } from '../domain/commitments.js';
import { orderStage } from '../domain/commitments.js';
import { orderValue } from '../domain/order-value.js';
import type { PurchaseOrder } from '../domain/procurement.js';
import { purchasingTimeline } from '../domain/purchasing-timeline.js';
import { isLiveSubmission } from '../domain/submissions.js';
import type { CommitmentContext } from './commitment-context.js';
import type { createSubmissionExecution } from './commitment-execution.js';
import type { createSubmissionRequests } from './commitment-submissions.js';
import type { PurchasingConnection, SubmissionView } from './commitments.js';

/**
 * Order and supplier records with their supplier lifecycle, Needs you attention across open
 * orders, and an on-demand read of a placed order.
 */
export function createCommitmentRecords(
  { deps, authorize, terms, progressFor }: CommitmentContext,
  {
    submissionView,
    readiness,
  }: Pick<
    ReturnType<typeof createSubmissionRequests>,
    'submissionView' | 'readiness'
  >,
  {
    locate,
    observe,
  }: Pick<ReturnType<typeof createSubmissionExecution>, 'locate' | 'observe'>,
) {
  /** Workflow runs among `orders` whose drafts replenishment verified; empty when unreadable. */
  async function verified(context: TenantContext, orders: PurchaseOrder[]) {
    const runs = orders
      .map((o) => o.origin.workflowRunId)
      .filter((v): v is string => !!v);

    return runs.length
      ? deps.verifiedDrafts(context, runs).catch(() => new Set<string>())
      : new Set<string>();
  }

  /** Reads an order with every record of its supplier lifecycle in one transaction. */
  async function record(context: TenantContext, orderId: string) {
    return deps.store.transaction(context.tenantId, false, async (tx) => {
      const order = await tx.order(orderId);
      if (!order) throw notFound('Purchase order not found');
      const supplier = await tx.supplier(order.supplierId);
      const submissions = await tx.submissions([orderId]);
      const commitments = await tx.commitments([orderId]);
      const followUps = await tx.followUps([orderId]);
      const communications = await tx.communications({ orderIds: [orderId] });
      const extractions = await tx.extractions(communications.map((c) => c.id));

      return {
        order,
        supplier,
        history: await tx.history(orderId),
        timelineEntries:
          (await tx.timeline?.(
            orderId,
            hasPermission(context, 'inventory.read'),
          )) ?? [],
        submissions,
        commitments,
        followUps,
        communications,
        extractions,
        observations: await tx.observations(orderId, 20),
        readiness: await readiness(context, tx, order, supplier),
      };
    });
  }

  const records = {
    /** Reads an order with its supplier lifecycle, evidence and what a person can do next. */
    async order(context: TenantContext, orderId: string) {
      context = await authorize(context);
      const data = await record(context, orderId);
      const verifiedRuns = await verified(context, [data.order]);
      const { progress, submission } = progressFor(data.order, {
        ...data,
        verified: verifiedRuns,
      });
      const canManage = hasPermission(context, 'procurement.manage');

      const { timelineEntries, ...recordData } = data;
      const timeline = purchasingTimeline({
        ...recordData,
        extra: [
          ...timelineEntries,
          ...((await deps.additionalTimeline?.(context, orderId)) ?? []),
        ],
      });

      if (deps.timelineActors)
        timeline.entries = await deps.timelineActors(
          context,
          timeline.entries,
          data.order.origin.workflowRunId,
        );

      return {
        ...recordData,
        value: orderValue(data.order),
        timeline,
        submission: submission
          ? await submissionView(context, submission)
          : null,
        progress,
        stage: orderStage(data.order, submission, progress),
        draftVerified:
          !!data.order.origin.workflowRunId &&
          verifiedRuns.has(data.order.origin.workflowRunId),
        canManage,
        reconciliation: {
          available: (await deps.reconciliationAvailable?.(context)) ?? false,
          decisions: (await deps.shortfallAvailable?.(context)) ?? false,
          manualReceipt:
            data.order.authority === 'luma' &&
            data.order.status === 'open' &&
            !data.supplier?.link &&
            !data.submissions.some((s) => s.channel !== 'email'),
        },
        extraction: {
          available: deps.model.available && !!deps.model.gateway,
          reason: deps.model.available ? null : deps.model.reason,
        },
      };
    },

    /**
     * Lists attention across open orders for Needs you, from persisted state only. `filter`
     * narrows the orders by supplier and status and the attention by kind.
     */
    async pending(
      context: TenantContext,
      filter: {
        supplierId?: string | undefined;
        status?: PurchaseOrder['status'] | undefined;
        /** Only attention of these kinds. */
        kinds?: Attention['kind'][] | undefined;
      } = {},
    ) {
      context = await authorize(context);
      const data = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) => {
          const submissions = await tx.submissions();
          const commitments = await tx.commitments();
          const orderIds = new Set([
            ...submissions
              .filter(isLiveSubmission)
              .map((s) => s.purchaseOrderId),
            ...commitments.map((c) => c.purchaseOrderId),
          ]);
          const found = new Map(
            (
              await tx.purchaseOrders(
                {
                  q: '',
                  supplierId: filter.supplierId,
                  status: filter.status,
                  ids: [...orderIds],
                },
                null,
                null,
              )
            ).map((row) => [row.record.id, row.record]),
          );
          const orders = [...orderIds]
            .map((id) => found.get(id))
            .filter(
              (o): o is PurchaseOrder =>
                !!o && !['closed', 'cancelled'].includes(o.status),
            );

          return {
            orders,
            submissions,
            commitments,
            followUps: await tx.followUps(orders.map((o) => o.id)),
            suppliers: new Map(
              await Promise.all(
                [...new Set(orders.map((o) => o.supplierId))].map(
                  async (id) => [id, await tx.supplier(id)] as const,
                ),
              ),
            ),
          };
        },
      );
      const items: {
        attention: Attention;
        order: PurchaseOrder;
        supplierName: string;
        submission: SubmissionView | null;
        commitment: Commitment | null;
        line: PurchaseOrder['lines'][number] | null;
        canRespond: boolean;
      }[] = [];
      for (const order of data.orders) {
        const { progress, submission } = progressFor(order, {
          ...data,
          supplier: data.suppliers.get(order.supplierId) ?? null,
          verified: new Set(),
        });
        const wanted = progress.attention.filter(
          (attention) => !filter.kinds || filter.kinds.includes(attention.kind),
        );
        if (!wanted.length) continue;
        const view = submission
          ? await submissionView(context, submission)
          : null;
        for (const attention of wanted) {
          if (
            attention.kind === 'submission_approval' &&
            view?.state === 'expired'
          )
            continue;
          items.push({
            attention,
            order,
            supplierName: order.supplierName,
            submission: view,
            commitment:
              data.commitments.find((c) => c.id === attention.commitmentId) ??
              null,
            line: order.lines.find((l) => l.id === attention.lineId) ?? null,
            canRespond:
              attention.kind === 'submission_approval'
                ? !!view?.canApprove
                : attention.kind === 'submission_uncertain'
                  ? !!view?.canCheck
                  : hasPermission(context, 'procurement.manage'),
          });
        }
      }

      return items;
    },
    /** Reads a supplier with its orders, open attention and recent messages. */
    async supplier(context: TenantContext, supplierId: string) {
      context = await authorize(context);
      const data = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) => {
          const supplier = await tx.supplier(supplierId);
          if (!supplier) throw notFound('Supplier not found');
          const orders = (await tx.orders()).filter(
            (o) => o.supplierId === supplierId,
          );
          const ids = orders.map((o) => o.id);

          return {
            supplier,
            orders,
            submissions: ids.length ? await tx.submissions(ids) : [],
            commitments: ids.length ? await tx.commitments(ids) : [],
            followUps: ids.length ? await tx.followUps(ids) : [],
            communications: (await tx.communications({ supplierId })).slice(
              0,
              20,
            ),
          };
        },
      );
      const verifiedRuns = await verified(context, data.orders);
      const connection =
        data.supplier.link && deps.purchasing
          ? ((
              await deps.purchasing
                .connections(context)
                .catch(() => [] as PurchasingConnection[])
            ).find((c) => c.id === data.supplier.link!.connectionId) ?? null)
          : null;

      return {
        supplier: data.supplier,
        connection,
        confirmationHours: terms(data.supplier).confirmationHours,
        canManage: hasPermission(context, 'procurement.manage'),
        communications: data.communications,
        orders: data.orders.map((order) => {
          const { progress, submission } = progressFor(order, {
            ...data,
            supplier: data.supplier,
            verified: verifiedRuns,
          });

          return {
            order,
            stage: orderStage(order, submission, progress),
            progress,
            externalOrderNumber: submission?.externalOrder?.orderNumber ?? null,
          };
        }),
      };
    },

    /** Reads the purchasing-system order now and records new confirmations and receipts. */
    async refresh(context: TenantContext, orderId: string) {
      context = await authorize(context);
      const submission = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) =>
          (await tx.submissions([orderId])).find(
            (s) => s.state === 'submitted',
          ) ?? null,
      );
      if (!submission?.externalOrder)
        throw conflict(
          'This order has not been placed in a purchasing system.',
        );
      const found = await locate(context, submission);
      if (!found)
        throw unavailable(
          'The purchasing system could not be read. The details below may be out of date.',
        );
      await observe(context, submission, found);

      return records.order(context, orderId);
    },
  };

  return records;
}
