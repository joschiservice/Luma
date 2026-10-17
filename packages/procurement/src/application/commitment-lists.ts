import type { TenantContext } from '@luma/identity';
import { hasPermission } from '@luma/identity';
import { unavailable } from '@luma/platform';

import type {
  Commitment,
  FollowUp,
  OrderStage,
  Submission,
} from '../domain/commitments.js';
import { orderStage } from '../domain/commitments.js';
import { orderValue } from '../domain/order-value.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import type { CommitmentContext } from './commitment-context.js';
import type { CommitmentTransaction } from './commitments.js';
import {
  customFieldIds,
  customListFields,
  customSortField,
  readableCustomFields,
  withCustomReader,
} from './custom-fields.js';
import { listQueryError, planListWhere } from './list-conditions.js';
import {
  comparePositions,
  type ListCustomField,
  type ListGroupKey,
  type ListPosition,
  listScope,
  listTimeZone,
  type OrderSummary,
  type Positioned,
  purchaseOrderDirection,
  type PurchaseOrderFilter,
  type PurchaseOrderList,
  type PurchaseOrderListQuery,
  readListCursor,
  writeListCursor,
} from './lists.js';
import {
  derivedKeyComparator,
  derivedPosition,
  groupMember,
  groupPurchaseOrders,
  isStoredSort,
  type PositionedRow,
  purchaseOrderFields,
  purchaseOrderGroupField,
  type PurchaseOrderRow,
} from './purchase-order-list.js';

/**
 * Purchase-order summaries and lists: each order's stage, expected date and attention evaluated
 * at one read time, list pages and groups, and suppliers with overdue confirmations.
 */
export function createCommitmentLists({
  deps,
  authorize,
  progressFor,
  suppliersOf,
}: CommitmentContext) {
  /** The list summary of one order: stage, expected date, attention and next owner. */
  function summaryOf(
    order: PurchaseOrder,
    data: {
      submissions: Submission[];
      commitments: Commitment[];
      followUps: FollowUp[];
      supplier: Supplier | null;
      verified: Set<string>;
      now?: Date;
    },
  ): OrderSummary {
    const { progress, submission } = progressFor(order, data);

    return {
      id: order.id,
      stage: orderStage(order, submission, progress),
      expectedDate: progress.expectedDate,
      // A pending approval shows in the stage; count what needs an answer beyond it.
      attention: progress.attention.filter(
        (a) => a.kind !== 'submission_approval',
      ).length,
      attentionKinds: [
        ...new Set(
          progress.attention
            .filter((a) => a.kind !== 'submission_approval')
            .map((a) => a.kind),
        ),
      ],
      overdue: progress.attention.some((a) =>
        ['confirmation_overdue', 'delivery_overdue'].includes(a.kind),
      ),
      nextOwner: progress.next.owner,
      externalOrderNumber: submission?.externalOrder?.orderNumber ?? null,
      confirmationDueAt: progress.confirmationDueAt,
      nextCheckAt: progress.nextCheckAt,
      value: orderValue(order),
    };
  }

  /**
   * Summarizes `orders` at `now` from their submissions, commitments, follow-ups and supplier
   * terms, read in one procurement transaction. Without `ids`, reads related records of every order.
   */
  async function summarize(
    tx: CommitmentTransaction,
    orders: PurchaseOrder[],
    now: Date,
    ids?: string[],
  ) {
    const group = <T extends { purchaseOrderId: string }>(rows: T[]) => {
      const grouped = new Map<string, T[]>();
      for (const row of rows) {
        const list = grouped.get(row.purchaseOrderId) ?? [];
        list.push(row);
        grouped.set(row.purchaseOrderId, list);
      }

      return grouped;
    };
    const submissions = group(await tx.submissions(ids));
    const commitments = group(await tx.commitments(ids));
    const followUps = group(await tx.followUps(ids));
    const suppliers = await suppliersOf(tx, orders);

    return new Map(
      orders.map((order) => [
        order.id,
        summaryOf(order, {
          submissions: submissions.get(order.id) ?? [],
          commitments: commitments.get(order.id) ?? [],
          followUps: followUps.get(order.id) ?? [],
          supplier: suppliers.get(order.supplierId) ?? null,
          // Draft verification only explains the drafted milestone, not the summary.
          verified: new Set(),
          now,
        }),
      ]),
    );
  }

  /** Whether a summary matches a stage filter; `attention` means any open item to answer. */
  const inStage = (
    summary: OrderSummary | undefined,
    stage: PurchaseOrderListQuery['stage'],
  ) =>
    !!summary &&
    (stage === undefined ||
      (stage === 'attention'
        ? summary.attention > 0
        : summary.stage === stage));

  return {
    /** Summarizes every order's stage, expected date and open attention for lists. */
    async summaries(context: TenantContext) {
      context = await authorize(context);
      const now = deps.now();

      return [
        ...(
          await deps.store.transaction(context.tenantId, false, async (tx) =>
            summarize(tx, await tx.orders(), now),
          )
        ).values(),
      ];
    },
    /**
     * Lists one page of purchase orders, or every group's first rows with `group`. Stage,
     * attention, next owner and the progress dates follow the same progress rules as the order
     * record, evaluated at the first page's time so later pages do not shift; conditions,
     * groups and sorts on them read every order that matches the stored conditions before
     * paging. An unfiltered first page also counts every order in the workspace per stage and
     * needing attention. Conditions and the sort may name readable custom purchase-order
     * fields, which filter and order in SQL before paging. Throws a 400 error for invalid
     * conditions, groups, cursors issued for another query and archived or unknown custom
     * fields, and a 403 error for custom fields the reader may not read.
     */
    async listOrders(
      context: TenantContext,
      query: PurchaseOrderListQuery,
    ): Promise<PurchaseOrderList> {
      context = await authorize(context);
      const { tenantId } = context;
      const direction = purchaseOrderDirection(query);
      const group = query.group
        ? purchaseOrderGroupField(query.group.field, query.group.granularity)
        : null;
      if (query.groupKey !== undefined && !group)
        throw listQueryError('Choose a grouping to read one group.');
      const grouped = !!group && query.groupKey === undefined;
      if (grouped && query.cursor)
        throw listQueryError(
          'Use a group’s page link together with its group key.',
        );
      const timeZone = listTimeZone(query.timeZone);
      // Page sizes are not part of the scope, so a group's later pages may use another size.
      const scopeFor = (groupKey: ListGroupKey | undefined) =>
        listScope(deps.digest, 'purchase-orders-v2', tenantId, {
          q: query.q,
          supplierId: query.supplierId ?? null,
          status: query.status ?? null,
          stage: query.stage ?? null,
          where: query.where ?? null,
          group: query.group ?? null,
          groupKey: groupKey === undefined ? null : { key: groupKey },
          timeZone,
          sort: query.sort,
          direction,
        });
      const scope = scopeFor(query.groupKey);
      const cursor = query.cursor
        ? readListCursor(query.cursor, scope, 'purchase order', true)
        : null;
      const asOf = cursor?.asOf ?? deps.now().toISOString();
      const now = new Date(asOf);
      const after: ListPosition | null = cursor
        ? { rank: cursor.rank, keys: cursor.keys, id: cursor.id }
        : null;
      const customIds = customFieldIds(query.where, query.sort);
      const where = withCustomReader(query.where, context.actor.id);
      const member =
        group && query.groupKey !== undefined
          ? groupMember(group, query.groupKey)
          : null;
      const storedSort = isStoredSort(query.sort) ? query.sort : null;
      const exact = query.count === 'exact' || !!member;
      const unfiltered =
        !cursor &&
        !query.q &&
        !query.stage &&
        !query.supplierId &&
        !query.status &&
        !query.where?.conditions.length &&
        !group;
      const read = await deps.store.transaction(tenantId, false, async (tx) => {
        // Custom field definitions come from the snapshot whose values they filter.
        let custom: ListCustomField[] = [];
        if (customIds.length) {
          if (!tx.customFields)
            throw unavailable('Custom fields are unavailable.');
          custom = readableCustomFields(
            context,
            customIds,
            await tx.customFields('purchase_order', customIds),
          );
          customSortField(custom, query.sort);
        }
        const plan = planListWhere(
          where,
          {
            ...purchaseOrderFields,
            ...customListFields<PurchaseOrderRow>(custom),
          },
          { now, timeZone },
        );
        const filter: PurchaseOrderFilter = {
          q: query.q,
          supplierId: query.supplierId,
          status: query.status,
          conditions: plan.stored ?? undefined,
          customFields: custom,
        };
        // Derived values decide matches, groups or order, so those queries read every match.
        const derived =
          !!plan.memory || query.stage !== undefined || !!group || !storedSort;
        const rows = await tx.purchaseOrders(
          filter,
          storedSort ? { sort: storedSort, direction, after } : null,
          derived ? null : query.limit + 1,
        );
        // Stored sorts read the rows after the cursor in SQL order; counting needs them all.
        const every =
          derived && exact && after && storedSort
            ? await tx.purchaseOrders(filter, null, null)
            : null;
        const total =
          query.count === 'exact' && !derived
            ? await tx.countPurchaseOrders(filter)
            : null;
        // Workspace counts come with an unfiltered first page, such as the page overview.
        const all = unfiltered ? await tx.orders() : null;
        const orders = new Map(
          [
            ...(all ?? []),
            ...[...rows, ...(every ?? [])].map((row) => row.record),
          ].map((order) => [order.id, order]),
        );
        const summaries = await summarize(
          tx,
          [...orders.values()],
          now,
          all ? undefined : [...orders.keys()],
        );

        return {
          rows,
          every,
          total,
          all,
          summaries,
          memory: plan.memory,
          derived,
        };
      });
      const { summaries, memory, derived } = read;
      const compareKeys = derivedKeyComparator(query.sort);
      const matching = (rows: Positioned<PurchaseOrder>[]) => {
        const list = rows
          .map((row): PositionedRow => {
            const summary = summaries.get(row.record.id)!;
            const record = { order: row.record, summary };

            return {
              ...record,
              position: isStoredSort(query.sort)
                ? row.position
                : derivedPosition(record, query.sort),
            };
          })
          .filter(
            (row) =>
              inStage(row.summary, query.stage) &&
              (memory?.(row) ?? true) &&
              (member?.(row) ?? true),
          );

        return storedSort
          ? list
          : list.sort((a, b) =>
              comparePositions(a.position, b.position, direction, compareKeys),
            );
      };
      const matched = matching(read.rows);
      const rows =
        !storedSort && after
          ? matched.filter(
              (row) =>
                comparePositions(row.position, after, direction, compareKeys) >
                0,
            )
          : matched;
      const item = (row: PurchaseOrderRow) => ({
        ...row.order,
        summary: row.summary,
      });
      const canManage = hasPermission(context, 'procurement.manage');
      if (group && grouped) {
        const result = groupPurchaseOrders(
          rows,
          group,
          Math.min(Math.max(query.groupLimit ?? 10, 1), 50),
          (key, last) => writeListCursor(scopeFor(key), last, asOf),
        );

        return {
          items: result.items.map(item),
          canManage,
          totalCount: query.count === 'exact' ? rows.length : null,
          counts: null,
          nextCursor: null,
          groups: result.groups,
          groupsTruncated: result.truncated,
          asOf,
        };
      }
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > query.limit && last
          ? writeListCursor(scope, last.position, asOf)
          : null;
      const totalCount =
        read.total ??
        (exact && derived
          ? read.every
            ? matching(read.every).length
            : matched.length
          : null);
      let counts: PurchaseOrderList['counts'] = null;
      if (read.all) {
        const stages: Partial<Record<OrderStage, number>> = {};
        let attention = 0;
        for (const order of read.all) {
          const summary = summaries.get(order.id)!;
          stages[summary.stage] = (stages[summary.stage] ?? 0) + 1;
          if (summary.attention > 0) attention++;
        }
        counts = { all: read.all.length, attention, stages };
      }

      return {
        items: page.map(item),
        canManage,
        totalCount,
        counts,
        nextCursor,
        ...(member
          ? {
              groups: [
                {
                  key: query.groupKey ?? null,
                  count: totalCount ?? 0,
                  complete: true,
                  itemIds: page.map((row) => row.order.id),
                  nextCursor,
                  sums: [],
                },
              ],
            }
          : {}),
        asOf,
      };
    },
    /**
     * Suppliers with at least one order whose progress has an open `confirmation_overdue` item
     * at the read time. Only orders with a verified submission can have one, so only those
     * are summarized.
     */
    async confirmationOverdueSuppliers(context: TenantContext) {
      context = await authorize(context);
      const now = deps.now();

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const ids = [
          ...new Set(
            (await tx.submissions())
              .filter((submission) => submission.state === 'submitted')
              .map((submission) => submission.purchaseOrderId),
          ),
        ];
        if (!ids.length) return [];
        const orders = (await tx.purchaseOrders({ q: '', ids }, null, null))
          .map((row) => row.record)
          .filter((order) => order.status !== 'cancelled');
        const summaries = await summarize(
          tx,
          orders,
          now,
          orders.map((order) => order.id),
        );

        return [
          ...new Set(
            orders
              .filter((order) =>
                summaries
                  .get(order.id)
                  ?.attentionKinds.includes('confirmation_overdue'),
              )
              .map((order) => order.supplierId),
          ),
        ];
      });
    },
  };
}
