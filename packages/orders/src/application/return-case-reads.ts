import {
  hasPermission,
  requirePermission,
  type TenantContext,
} from '@luma/identity';
import { invalid, notFound, unavailable } from '@luma/platform';

import { lineAvailability } from '../domain/return-cases.js';
import type { ReturnCreation } from '../domain/return-creations.js';
import type { ReturnCaseSupport } from './return-case-support.js';
import type { ReturnCaseViews } from './return-case-views.js';
import type {
  OrderReturnCases,
  ReturnCaseAttention,
  ReturnCaseDependencies,
  ReturnCaseList,
} from './return-cases.js';

/** Case reads: an order's cases, case search, open attention and one case's detail. */
export function createReturnCaseReads(
  deps: ReturnCaseDependencies,
  support: ReturnCaseSupport,
  views: ReturnCaseViews,
) {
  const { authorize } = support;
  const { admissionReads, creationView, summary, detail } = views;

  return {
    /** Lists an order's return cases and what each source can still return. */
    async forOrder(
      context: TenantContext,
      orderId: string,
    ): Promise<OrderReturnCases> {
      context = await authorize(context);
      const data = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) => {
          const sources = await tx.orderSources(orderId);
          if (!sources.length) return null;
          const cases = await tx.cases(orderId);
          // An order has few cases; one transaction runs one query at a time.
          const creations = new Map<string, ReturnCreation[]>();
          for (const item of cases)
            creations.set(item.id, await tx.creations(item.id));

          return {
            sources,
            cases,
            creations,
            storeReturns: await tx.storeReturns(orderId),
            people: await tx.people(
              cases.flatMap((c) => (c.assigneeId ? [c.assigneeId] : [])),
            ),
          };
        },
      );
      if (!data) throw notFound('Order not found');
      const { sources, cases, storeReturns, people, creations } = data;

      return {
        sources: sources.map((source) => {
          const own = storeReturns.filter(
            (r) => r.connectionId === source.connectionId,
          );
          const available = lineAvailability(
            source.lines,
            cases.filter((c) => c.connectionId === source.connectionId),
            own,
          );

          return {
            connectionId: source.connectionId,
            displayNumber: source.displayNumber,
            lines: source.lines.map((line) => ({
              orderLineId: line.id,
              title: line.title,
              sku: line.sku,
              unit: line.unit,
              ...available.get(line.id)!,
            })),
            storeReturns: own.map((r) => ({
              id: r.entityId,
              name: r.name,
              status: r.status,
              caseId:
                cases.find(
                  (c) =>
                    c.sourceReturnId === r.entityId && c.state !== 'cancelled',
                )?.id ?? null,
            })),
          };
        }),
        cases: cases.map((c) => summary(c, creations.get(c.id) ?? [], people)),
        canManage: hasPermission(context, 'returns.manage'),
      };
    },

    /** Searches persisted cases without provider reads; customer filtering also requires customer access. */
    async list(
      context: TenantContext,
      query: {
        q: string;
        customerId?: string;
        openOnly?: boolean;
        cursor?: string;
        limit: number;
      },
    ): Promise<ReturnCaseList> {
      context = await authorize(context);
      if (query.customerId) requirePermission(context, 'customers.read');
      if (
        !Number.isInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > 50 ||
        query.q.length > 120
      )
        throw invalid(
          'Choose a page size from 1 to 50 and a search up to 120 characters.',
        );
      const scope = deps.digest([
        context.tenantId,
        query.q,
        query.customerId ?? null,
        !!query.openOnly,
      ]);
      let after: { at: string; id: string } | undefined;
      if (query.cursor) {
        try {
          const decoded: unknown = JSON.parse(
            Buffer.from(query.cursor, 'base64url').toString(),
          );
          if (
            !decoded ||
            typeof decoded !== 'object' ||
            !('scope' in decoded) ||
            decoded.scope !== scope ||
            !('at' in decoded) ||
            typeof decoded.at !== 'string' ||
            !Number.isFinite(Date.parse(decoded.at)) ||
            !('id' in decoded) ||
            typeof decoded.id !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
              decoded.id,
            )
          )
            throw new Error('Cursor');
          after = { at: decoded.at, id: decoded.id };
        } catch {
          throw invalid(
            'This page link no longer matches the case search. Start from the first page.',
          );
        }
      }

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const rows = await tx.findCases({
          q: query.q,
          ...(query.customerId ? { customerId: query.customerId } : {}),
          ...(query.openOnly ? { openOnly: true } : {}),
          ...(after ? { after } : {}),
          limit: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        const people = await tx.people(
          page.flatMap(({ value }) => [
            value.openedBy,
            ...(value.assigneeId ? [value.assigneeId] : []),
          ]),
        );
        const last = page.at(-1)?.value;

        return {
          items: page.map(({ value, orderNumber, creation }) => ({
            ...summary(value, creation ? [creation] : [], people),
            orderNumber,
          })),
          nextCursor:
            rows.length > query.limit && last
              ? Buffer.from(
                  JSON.stringify({ scope, at: last.updatedAt, id: last.id }),
                ).toString('base64url')
              : null,
        };
      });
    },

    /** Lists bounded, persisted open case attention for the shared decision queue; never reads a provider. */
    async pending(context: TenantContext): Promise<ReturnCaseAttention[]> {
      context = await authorize(context);
      const data = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) => {
          const rows = await tx.findCases({
            q: '',
            openOnly: true,
            limit: 501,
          });
          if (rows.length > 500)
            throw unavailable(
              'Return attention exceeds this view’s read limit. Open return cases from their orders or search.',
            );
          const items = rows.map((row) => ({
            ...row,
            assignment:
              row.value.assigneeId &&
              row.assignment?.details.assigneeId === row.value.assigneeId
                ? {
                    assigneeId: row.value.assigneeId,
                    assignedBy: row.assignment.actorId,
                    assignedAt: row.assignment.occurredAt,
                    revision: row.value.revision,
                  }
                : null,
          }));
          const people = await tx.people(
            items.flatMap(({ value, creation }) => [
              value.openedBy,
              ...(value.assigneeId ? [value.assigneeId] : []),
              ...(creation
                ? [
                    creation.requestedBy,
                    ...(creation.decidedBy ? [creation.decidedBy] : []),
                  ]
                : []),
            ]),
          );

          return { items, people };
        },
      );
      // One authorized admission read covers every listed creation's decision.
      const decisionIds = data.items.flatMap(({ creation }) =>
        creation?.decisionId ? [creation.decisionId] : [],
      );
      const reads = admissionReads(
        context,
        deps.admission && decisionIds.length
          ? await deps.admission.decisions(context, decisionIds)
          : undefined,
      );
      const result: ReturnCaseAttention[] = [];
      for (const {
        value,
        orderNumber,
        creation,
        assignment,
        completion,
        exchangeId,
        settlement,
      } of data.items)
        result.push({
          case: {
            ...summary(value, creation ? [creation] : [], data.people),
            orderNumber,
            revision: value.revision,
          },
          assignment,
          ...(completion?.state === 'unresolved' && exchangeId
            ? {
                completion: {
                  ...completion,
                  exchangeId,
                  ownerId: value.assigneeId ?? value.openedBy,
                },
              }
            : {}),
          creation: creation
            ? await creationView(context, creation, data.people, reads)
            : null,
          settlement: settlement ?? null,
          canManage: hasPermission(context, 'returns.manage'),
        });

      return result;
    },

    /** Reads one return case with its lines, decisions, history and creation state. */
    async get(context: TenantContext, caseId: string) {
      context = await authorize(context);

      return detail(context, caseId);
    },
  };
}
