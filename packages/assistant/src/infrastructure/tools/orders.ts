import { IdentityError } from '@luma/identity';
import type { OrderWorkspace } from '@luma/read-models';
import { z } from 'zod';

import { defineTool } from '../../application/tools.js';
import { citationMarker, clip } from '../../domain/answer.js';
import {
  humanize,
  instant,
  issueReference,
  members,
  money,
  orderReference,
  parser,
  range,
  returnReference,
  summary,
} from './references.js';

type OrderQuery = Parameters<OrderWorkspace['list']>[1];

type OrderItem = Awaited<ReturnType<OrderWorkspace['list']>>['items'][number];

const views = members<OrderQuery['view']>({
  all: true,
  outstanding: true,
  overdue: true,
  needs_you: true,
  differs: true,
});
const sorts = members<OrderQuery['sort']>({
  updated: true,
  placed: true,
  number: true,
  due: true,
});
// Canonical order and payment statuses, as the Orders API filters them.
const statuses = ['open', 'completed', 'cancelled', 'unknown'] as const;
const paymentStatuses = [
  'pending',
  'authorized',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
  'unknown',
] as const;

const searchInput = z
  .object({
    q: z.string().trim().max(120).default(''),
    view: z.enum(views).default('all'),
    status: z.enum(statuses).optional(),
    paymentStatus: z.enum(paymentStatuses).optional(),
    placedFrom: instant.optional(),
    placedBefore: instant.optional(),
    updatedFrom: instant.optional(),
    updatedBefore: instant.optional(),
    sort: z.enum(sorts).default('updated'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    limit: z.number().int().min(1).max(25).default(10),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();

const timestamp = {
  type: 'string',
  description: 'ISO 8601 timestamp with an offset or Z.',
};

function orderRow(order: OrderItem) {
  return {
    cite: citationMarker('order', order.id),
    number: order.displayNumber,
    placedAt: order.placedAt,
    total: money(order.total),
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillment: order.fulfillment,
    open: order.open,
    overdue: order.overdue,
    dueAt: order.dueAt,
    lines: order.lineCount,
    issuesNeedingAttention: order.issueIds.length,
    sourcesDisagree: order.differs,
    sources: order.sources
      .filter((source) => !source.deleted)
      .map((source) => source.label),
    observedAt: order.observedAt,
  };
}

/** Searches orders with the same filters, views and metric definitions as the Orders page. */
export function searchOrdersTool(orders: Pick<OrderWorkspace, 'list'>) {
  return defineTool(parser(searchInput), {
    name: 'search_orders',
    label: 'Search orders',
    reads: 'order',
    permission: 'orders.read',
    description:
      'Search current orders from connected sources, as on the Orders page. `q` matches order numbers, source order IDs and SKU text. Views: `outstanding` (open orders not yet fulfilled), `overdue` (outstanding past their due time), `needs_you` (orders with issues needing a person), `differs` (sources disagree), `all`. Filter by status, payment status and placed or updated time ranges (from is inclusive, before is exclusive). Returns the total number of matches and up to `limit` orders; pass `nextCursor` back as `cursor` with the same filters for the next page.',
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: {
          type: 'string',
          maxLength: 120,
          description: 'Order number, source order ID or SKU text.',
        },
        view: { type: 'string', enum: views },
        status: { type: 'string', enum: [...statuses] },
        paymentStatus: {
          type: 'string',
          enum: [...paymentStatuses],
        },
        placedFrom: timestamp,
        placedBefore: timestamp,
        updatedFrom: timestamp,
        updatedBefore: timestamp,
        sort: { type: 'string', enum: sorts },
        direction: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
        cursor: { type: 'string' },
      },
    },
    describe: (input) =>
      summary('Searched orders', [
        input.view !== 'all' && humanize(input.view),
        input.q && `“${input.q}”`,
        input.status && humanize(input.status),
        input.paymentStatus && `payment ${humanize(input.paymentStatus)}`,
        range('placed', input.placedFrom, input.placedBefore),
        range('updated', input.updatedFrom, input.updatedBefore),
        input.cursor && 'next page',
      ]),
    async run(context, input) {
      const list = await orders.list(context, { ...input, count: 'exact' });

      return {
        data: {
          totalMatches: list.totalCount,
          items: list.items.map(orderRow),
          nextCursor: list.nextCursor,
          asOf: list.asOf,
        },
        records: list.items.map(orderReference),
      };
    },
  });
}

const getInput = z.object({ orderId: z.string().uuid() }).strict();

/** Reads one order: each source's facts, lines, fulfillment, returns, issues and workflow runs. */
export function getOrderTool(orders: Pick<OrderWorkspace, 'get'>) {
  return defineTool(parser(getInput), {
    name: 'get_order',
    label: 'Read an order',
    reads: 'order',
    permission: 'orders.read',
    description:
      'Read one order by its Luma ID (the UUID in its cite marker): what each source reports, where sources disagree, line quantities with fulfilled and remaining units, fulfillments, returns and refunds, linked issues and workflow runs. Customer and payment details are not available.',
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['orderId'],
      properties: { orderId: { type: 'string', format: 'uuid' } },
    },
    describe: () => 'Read order details',
    async run(context, input) {
      const detail = await orders.get(context, input.orderId);
      if (!detail) throw new IdentityError(404, 'NOT_FOUND', 'Order not found');
      const sources = new Map(
        detail.sources.map((source) => [source.connectionId, source]),
      );
      const label = (connectionId: string) =>
        sources.get(connectionId)?.label ?? 'Unknown source';
      const issues = detail.issues.map((issue) => ({
        reference: issueReference({
          id: issue.id,
          class: issue.class,
          state: issue.state,
          observedAt: issue.lastDetectedAt,
        }),
        row: {
          cite: citationMarker('issue', issue.id),
          class: issue.class,
          state: issue.state,
          severity: issue.severity,
          needsYou: issue.needsYou,
          relationship: issue.relationship,
          lastDetectedAt: issue.lastDetectedAt,
        },
      }));
      const returns = detail.returns.slice(0, 10);

      return {
        data: {
          order: orderRow(detail.order),
          sources: detail.sources.map((source) => ({
            source: source.label,
            system: source.system,
            selected: source.selected,
            number: source.displayNumber,
            status: source.status,
            paymentStatus: source.paymentStatus,
            total: money(source.total),
            fulfillment: source.fulfillment,
            dueAt: source.dueAt,
            observedAt: source.observedAt,
            sourceUpdatedAt: source.sourceUpdatedAt,
            lines: source.lines.slice(0, 30).map((line) => ({
              sku: line.skuCode,
              title: clip(line.title, 80),
              quantity: line.quantity,
              cancelled: line.cancelledQuantity,
              fulfilled: line.fulfilledQuantity,
              remaining: line.remainingQuantity,
              unit: line.unit,
            })),
            linesOmitted: Math.max(0, source.lines.length - 30),
          })),
          differences: detail.differences.map((difference) => ({
            field: difference.field,
            values: difference.values.map((value) => ({
              source: label(value.connectionId),
              value: value.value,
            })),
          })),
          fulfillments: detail.fulfillments.slice(0, 10).map((item) => ({
            source: label(item.connectionId),
            status: item.status,
            lastProgressAt: item.lastProgressAt,
            failureCode: item.failureCode,
            deleted: item.deleted,
          })),
          returns: returns.map((item) => ({
            cite: citationMarker('return', item.id),
            kind: item.kind,
            stage: item.stage,
            refund: item.refund.state,
            refunded: item.refund.refunded,
            value: money(item.value),
          })),
          issues: issues.map((issue) => issue.row),
          workflows: detail.workflows.slice(0, 5).map((run) => ({
            name: run.name,
            state: run.state,
            startedAt: run.createdAt,
          })),
          asOf: detail.asOf,
        },
        records: [
          orderReference(detail.order),
          ...issues.map((issue) => issue.reference),
          ...returns.map((item) =>
            returnReference(item, sources.get(item.connectionId)),
          ),
        ],
      };
    },
  });
}
