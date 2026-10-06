import type {
  FulfillmentWorkspace,
  InventoryWorkspace,
  ReturnWorkspace,
} from '@luma/read-models';
import { z } from 'zod';

import { defineTool } from '../../application/tools.js';
import { citationMarker, clip } from '../../domain/answer.js';
import {
  humanize,
  latest,
  members,
  money,
  parser,
  returnReference,
  sourcesOf,
  summary,
} from './references.js';

type StockQuery = Parameters<InventoryWorkspace['list']>[1];

type FulfillmentQuery = Parameters<FulfillmentWorkspace['list']>[1];

type ReturnQuery = Parameters<ReturnWorkspace['list']>[1];

const stockViews = members<StockQuery['view']>({
  all: true,
  differs: true,
  unknown: true,
});
const fulfillmentViews = members<FulfillmentQuery['view']>({
  attention: true,
  held: true,
  delayed: true,
  open: true,
  in_transit: true,
  all: true,
});
const fulfillmentSorts = members<FulfillmentQuery['sort']>({
  waiting: true,
  recent: true,
  deadline: true,
});
const fulfillmentKinds = members<NonNullable<FulfillmentQuery['kind']>>({
  fulfillment_order: true,
  shipment: true,
});
const returnViews = members<ReturnQuery['view']>({
  action: true,
  waiting: true,
  done: true,
  all: true,
});
const returnStages = members<NonNullable<ReturnQuery['stage']>>({
  requested: true,
  awaiting_items: true,
  awaiting_refund: true,
  refund_pending: true,
  refund_failed: true,
  ready_to_close: true,
  closed: true,
  declined: true,
  cancelled: true,
  refunded: true,
  refund_recorded: true,
  unknown: true,
});
const returnSorts = members<ReturnQuery['sort']>({
  requested: true,
  activity: true,
});

const stockInput = z
  .object({
    q: z.string().trim().max(120).default(''),
    view: z.enum(stockViews).default('all'),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();

/** Searches stock positions with each source's reported quantities. */
export function searchStockTool(inventory: Pick<InventoryWorkspace, 'list'>) {
  return defineTool(parser(stockInput), {
    name: 'search_stock',
    label: 'Search stock',
    reads: 'stock_position',
    description:
      'Search stock positions (SKU at a location) as on the Inventory page. `q` matches SKU codes and keys. Views: `differs` (sources report different quantities), `unknown` (a source reports no quantity), `all`. Each source’s on-hand, reserved, available and incoming quantities are listed separately with when they were read; a missing quantity is unknown, not zero. Returns up to 50 positions per page.',
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', maxLength: 120, description: 'SKU code or key.' },
        view: { type: 'string', enum: stockViews },
        cursor: { type: 'string' },
      },
    },
    describe: (input) =>
      summary('Searched stock', [
        input.view !== 'all' && humanize(input.view),
        input.q && `“${input.q}”`,
        input.cursor && 'next page',
      ]),
    async run(context, input) {
      const list = await inventory.list(context, input);

      return {
        data: {
          items: list.items.map((position) => ({
            cite: citationMarker('stock_position', position.id),
            sku: position.sku,
            location: position.location,
            unit: position.unit,
            sourcesDisagreeOn: position.differences,
            sources: position.sources
              .filter((source) => !source.deleted)
              .map((source) => ({
                source: source.label,
                onHand: source.onHand,
                reserved: source.reserved,
                available: source.available,
                incoming: source.incoming,
                availability: source.availabilityBasis,
                observedAt: source.observedAt,
              })),
          })),
          nextCursor: list.nextCursor,
          asOf: list.asOf,
        },
        records: list.items.map((position) => {
          const current = position.sources.filter((source) => !source.deleted);

          return {
            kind: 'stock_position' as const,
            id: position.id,
            label: `${position.sku} at ${position.location}`,
            detail: position.differences.length
              ? 'Sources disagree'
              : current[0]?.available != null
                ? `${current[0].available} ${position.unit} available`
                : null,
            sources: sourcesOf(
              current.map((source) => ({ label: source.label, system: null })),
            ),
            observedAt: latest(current.map((source) => source.observedAt)),
            sourceUpdatedAt: latest(
              current.map((source) => source.sourceUpdatedAt),
            ),
          };
        }),
      };
    },
  });
}

const fulfillmentInput = z
  .object({
    q: z.string().trim().max(120).default(''),
    view: z.enum(fulfillmentViews).default('attention'),
    kind: z.enum(fulfillmentKinds).optional(),
    sort: z.enum(fulfillmentSorts).default('waiting'),
    limit: z.number().int().min(1).max(25).default(10),
    cursor: z.string().min(1).max(8192).optional(),
  })
  .strict();

/** Searches fulfillment work with the attention rules of the Fulfillment page. */
export function searchFulfillmentTool(
  fulfillment: Pick<FulfillmentWorkspace, 'list'>,
) {
  return defineTool(parser(fulfillmentInput), {
    name: 'search_fulfillment',
    label: 'Search fulfillment',
    reads: 'fulfillment',
    description:
      'Search fulfillment orders and shipments as on the Fulfillment page. Views: `attention` (held, overdue, stalled, failed or delivery problems), `held`, `delayed`, `open`, `in_transit`, `all`. `signals` explain why an item needs attention. `q` matches order numbers, tracking numbers and source IDs. Sort by `waiting` (longest without progress), `recent` or `deadline`. `counts` gives the number of items in each view.',
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', maxLength: 120 },
        view: { type: 'string', enum: fulfillmentViews },
        kind: { type: 'string', enum: fulfillmentKinds },
        sort: { type: 'string', enum: fulfillmentSorts },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
        cursor: { type: 'string' },
      },
    },
    describe: (input) =>
      summary('Searched fulfillment', [
        humanize(input.view),
        input.kind && humanize(input.kind),
        input.q && `“${input.q}”`,
        input.cursor && 'next page',
      ]),
    async run(context, input) {
      const list = await fulfillment.list(context, input);
      const sources = new Map(
        list.sources.map((source) => [source.connectionId, source]),
      );

      return {
        data: {
          counts: list.counts,
          items: list.items.map((item) => ({
            cite: citationMarker('fulfillment', item.id),
            kind: item.kind,
            status: item.status,
            open: item.open,
            signals: item.signals,
            holds: item.holds,
            order: { id: item.order.id, number: item.order.number },
            location: item.location?.name ?? null,
            method: item.method?.name ?? item.method?.type ?? null,
            fulfillBy: item.fulfillBy,
            estimatedDeliveryAt: item.estimatedDeliveryAt,
            lastProgressAt: item.lastProgressAt,
            delivery: item.delivery,
            failureCode: item.failureCode,
            carriers: [
              ...new Set(item.tracking.flatMap((t) => t.carrier ?? [])),
            ],
            units: item.units,
            source: sources.get(item.connectionId)?.label ?? null,
            observedAt: item.observedAt,
          })),
          stalledAfterHours: list.stalledAfterHours,
          nextCursor: list.nextCursor,
          asOf: list.asOf,
        },
        records: list.items.map((item) => {
          const source = sources.get(item.connectionId);

          return {
            kind: 'fulfillment' as const,
            id: item.id,
            label: [
              item.kind === 'shipment' ? 'Shipment' : 'Fulfillment',
              item.order.number && `for ${item.order.number}`,
            ]
              .filter(Boolean)
              .join(' '),
            detail: [humanize(item.status), ...item.signals.map(humanize)].join(
              ' · ',
            ),
            sources: source
              ? [{ label: source.label, system: source.system }]
              : [],
            observedAt: item.observedAt,
            sourceUpdatedAt: item.sourceUpdatedAt,
          };
        }),
      };
    },
  });
}

const returnInput = z
  .object({
    q: z.string().trim().max(120).default(''),
    view: z.enum(returnViews).default('all'),
    stage: z.enum(returnStages).optional(),
    sort: z.enum(returnSorts).default('requested'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    limit: z.number().int().min(1).max(25).default(10),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();

/** Searches returns and refunds with their stage and money returned. */
export function searchReturnsTool(returns: Pick<ReturnWorkspace, 'list'>) {
  return defineTool(parser(returnInput), {
    name: 'search_returns',
    label: 'Search returns',
    reads: 'return',
    description:
      'Search returns and refunds as on the Returns page. Views: `action` (needs a person), `waiting` (with the customer or payment provider), `done`, `all`; or filter by `stage`. `refunded` is money actually returned to the customer; `pending` is not yet paid out. `q` matches return names and order numbers. `counts` gives the number in each view and stage.',
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', maxLength: 120 },
        view: { type: 'string', enum: returnViews },
        stage: { type: 'string', enum: returnStages },
        sort: { type: 'string', enum: returnSorts },
        direction: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
        cursor: { type: 'string' },
      },
    },
    describe: (input) =>
      summary('Searched returns', [
        input.view !== 'all' && humanize(input.view),
        input.stage && humanize(input.stage),
        input.q && `“${input.q}”`,
        input.cursor && 'next page',
      ]),
    async run(context, input) {
      const list = await returns.list(context, input);
      const sources = new Map(
        list.sources.map((source) => [source.connectionId, source]),
      );

      return {
        data: {
          counts: list.counts,
          items: list.items.map((item) => ({
            cite: citationMarker('return', item.id),
            kind: item.kind,
            name: item.name,
            order: { id: item.order.id, number: item.order.displayNumber },
            stage: item.stage,
            status: item.status,
            refund: {
              state: item.refund.state,
              currency: item.refund.currency,
              refunded: item.refund.refunded,
              pending: item.refund.pending,
              failedAttempts: item.refund.failedAttempts,
            },
            quantity: item.quantity,
            received: item.received,
            value: money(item.value),
            reasons: item.reasons
              .slice(0, 3)
              .map((reason) => clip(reason, 120)),
            requestedAt: item.requestedAt,
            activityAt: item.activityAt,
            source: sources.get(item.connectionId)?.label ?? null,
            observedAt: item.observedAt,
          })),
          // Sources whose returns were never fully read can't show that a return is absent.
          sourcesNotFullyRead: list.sources
            .filter((source) => !source.fullReadAt)
            .map((source) => source.label),
          nextCursor: list.nextCursor,
          asOf: list.asOf,
        },
        records: list.items.map((item) =>
          returnReference(item, sources.get(item.connectionId)),
        ),
      };
    },
  });
}
