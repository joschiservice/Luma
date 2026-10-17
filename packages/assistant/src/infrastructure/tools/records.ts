import { notFound } from '@luma/platform';
import type {
  CustomerWorkspace,
  FulfillmentWorkspace,
  InventoryWorkspace,
} from '@luma/read-models';
import { z } from 'zod';

import { defineTool } from '../../application/tools.js';
import {
  citationMarker,
  clip,
  type RecordReference,
} from '../../domain/answer.js';
import { latest, parser } from './references.js';

const input = z.object({ id: z.string().uuid() }).strict();
const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};

/** Reads a stock position through the same permission-scoped detail service as its page. */
export function getStockTool(inventory: Pick<InventoryWorkspace, 'get'>) {
  return defineTool(parser(input), {
    name: 'get_stock',
    label: 'Read stock details',
    reads: 'stock_position',
    permission: 'inventory.read',
    description:
      'Read one stock position by ID, including separate source quantities and observation times, conflicts, observed history, linked work and sections hidden by permissions. Missing quantities are unknown, not zero. Purchase order status is not evidence of receipt.',
    jsonSchema,
    describe: () => 'Read stock details',
    async run(context, { id }) {
      const detail = await inventory.get(context, id);
      if (!detail) throw notFound('Stock position not found');
      const position = detail.position;
      const sources = position.sources.filter((source) => !source.deleted);
      const reference: RecordReference = {
        kind: 'stock_position',
        id: position.id,
        label: `${position.sku} at ${position.location}`,
        detail: position.differences.length ? 'Sources disagree' : null,
        sources: sources.map((source) => ({
          label: source.label,
          system: null,
        })),
        observedAt: latest(sources.map((source) => source.observedAt)),
        sourceUpdatedAt: latest(
          sources.map((source) => source.sourceUpdatedAt),
        ),
      };

      return {
        data: {
          cite: citationMarker('stock_position', position.id),
          position,
          history: {
            entries: detail.history.entries.slice(0, 10),
            truncated:
              detail.history.truncated || detail.history.entries.length > 10,
          },
          linkedOrders: detail.orders.slice(0, 10),
          purchaseOrders: detail.purchaseOrders.slice(0, 10),
          issues: detail.issues.slice(0, 10),
          relatedTruncated: detail.relatedTruncated,
          hidden: detail.hidden,
          asOf: detail.asOf,
        },
        records: [reference],
      };
    },
  });
}

/** Reads fulfillment facts and progress without treating a workflow write as verification. */
export function getFulfillmentTool(
  fulfillment: Pick<FulfillmentWorkspace, 'get'>,
) {
  return defineTool(parser(input), {
    name: 'get_fulfillment',
    label: 'Read fulfillment details',
    reads: 'fulfillment',
    permission: 'fulfillment.read',
    description:
      'Read one fulfillment by ID: source status, quantities, holds, deadlines, progress, observed history, workflow runs and linked issues. Hidden sections mean missing access. Successful workflow execution does not prove delivery or release of a hold.',
    jsonSchema,
    describe: () => 'Read fulfillment details',
    async run(context, { id }) {
      const detail = await fulfillment.get(context, id);
      if (!detail) throw notFound('Fulfillment not found');
      const { item, source } = detail;
      const reference: RecordReference = {
        kind: 'fulfillment',
        id: item.id,
        label: `Fulfillment for ${item.order.number ?? item.id}`,
        detail: item.status,
        sources: [{ label: source.label, system: source.system }],
        observedAt: item.observedAt,
        sourceUpdatedAt: item.sourceUpdatedAt,
      };

      return {
        data: {
          cite: citationMarker('fulfillment', item.id),
          item: {
            ...item,
            tracking: item.tracking.map(({ carrier, number }) => ({
              carrier,
              number,
            })),
          },
          source,
          lines: detail.lines.slice(0, 30),
          linesOmitted: Math.max(0, detail.lines.length - 30),
          timeline: {
            entries: detail.timeline.entries.slice(0, 10),
            truncated:
              detail.timeline.truncated || detail.timeline.entries.length > 10,
          },
          issues: detail.issues.slice(0, 10),
          workflows: detail.workflows.slice(0, 10),
          hidden: detail.hidden,
          asOf: detail.asOf,
        },
        records: [reference],
      };
    },
  });
}

/** Reads a source customer profile, preserving shared-data and source-access limits. */
export function getCustomerTool(customers: Pick<CustomerWorkspace, 'get'>) {
  return defineTool(parser(input), {
    name: 'get_customer',
    label: 'Read customer details',
    reads: 'customer',
    permission: 'customers.read',
    description:
      'Read one customer by ID: source profile state, shared contact/address availability, source-reported order count and spend, missing-since time and source access/freshness. Customers are not merged across sources. Withheld contact data is not absent data.',
    jsonSchema,
    describe: () => 'Read customer details',
    async run(context, { id }) {
      const detail = await customers.get(context, id);
      if (!detail) throw notFound('Customer not found');
      const { item, source } = detail;
      const reference: RecordReference = {
        kind: 'customer',
        id: item.id,
        label: clip(item.displayName) ?? 'Customer',
        detail: item.state,
        sources: source ? [{ label: source.label, system: source.system }] : [],
        observedAt: item.observedAt,
        sourceUpdatedAt: item.sourceUpdatedAt,
      };

      return {
        data: {
          cite: citationMarker('customer', item.id),
          customer: {
            displayName: clip(item.displayName),
            state: item.state,
            shared: item.shared,
            orderCount: item.orderCount,
            amountSpent: item.amountSpent,
            tags: item.tags.slice(0, 10).map((tag) => clip(tag)),
            missingSince: item.missingSince,
            observedAt: item.observedAt,
            sourceUpdatedAt: item.sourceUpdatedAt,
          },
          source,
          asOf: detail.asOf,
        },
        records: [reference],
      };
    },
  });
}
