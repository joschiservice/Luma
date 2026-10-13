import type { Permission } from '@luma/identity';
import type { Insights } from '@luma/read-models';
import { z } from 'zod';

import { defineTool } from '../../application/tools.js';
import {
  citationMarker,
  type RecordKind,
  type RecordReference,
} from '../../domain/answer.js';
import { parser } from './references.js';

const insightRecordQuerySchema = z
  .object({
    range: z.enum(['7d', '30d', '13w']).default('30d'),
    timeZone: z.string().min(1).max(64).default('UTC'),
    connectionId: z.string().uuid().optional(),
    point: z.string().min(1).max(40).optional(),
    series: z.string().min(1).max(40).optional(),
    asOf: z.string().datetime({ offset: true }).optional(),
    offset: z.number().int().min(0).max(10000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();

const charts = [
  'orders',
  'fulfillment',
  'stock',
  'cases',
  'procurement',
] as const;
const permissions: Record<(typeof charts)[number], Permission> = {
  orders: 'orders.read',
  fulfillment: 'fulfillment.read',
  stock: 'inventory.read',
  cases: 'issues.read',
  procurement: 'procurement.read',
};
const kinds: Record<(typeof charts)[number], RecordKind> = {
  orders: 'order',
  fulfillment: 'fulfillment',
  stock: 'stock_position',
  cases: 'issue',
  procurement: 'purchase_order',
};

/** Reads chart selections through their owner with unchanged filters and evaluation time. */
export function insightTools(insights: Insights) {
  return charts.map((chart) =>
    defineTool(parser(insightRecordQuerySchema), {
      name: `read_insight_${chart}`,
      label: 'Read chart records',
      reads: kinds[chart],
      permission: permissions[chart],
      additionalPermissions: ['insights.read'],
      description: `Read the exact ${chart} chart selection. Preserve range, timeZone, connectionId, point, series and asOf from navigation context. Invalid or expired selections cannot establish which records were counted. Unknown observation times must remain unknown; asOf is the evaluation time, not a provider read.`,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          range: { type: 'string', enum: ['7d', '30d', '13w'] },
          timeZone: { type: 'string' },
          connectionId: { type: 'string', format: 'uuid' },
          point: { type: 'string' },
          series: { type: 'string' },
          asOf: { type: 'string' },
          offset: { type: 'integer' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
      describe: () => 'Read exact chart selection',
      async run(context, query) {
        const [list, coverage] = await Promise.all([
          insights.records(context, chart, query),
          insights.chart(context, chart, query),
        ]);
        const references: RecordReference[] = list.items.map((item) => ({
          kind: item.kind === 'case' ? 'issue' : item.kind,
          id: item.id,
          label:
            item.kind === 'order'
              ? `Order ${item.number ?? item.id}`
              : item.kind === 'fulfillment'
                ? `Fulfillment for ${item.order.number ?? item.id}`
                : item.kind === 'stock_position'
                  ? item.sku
                  : item.kind === 'case'
                    ? item.class
                    : item.reference,
          detail:
            item.kind === 'purchase_order'
              ? item.stage
              : item.kind === 'case'
                ? item.state
                : item.kind === 'stock_position'
                  ? item.unknownReason
                  : item.status,
          sources:
            item.kind === 'order'
              ? item.sources.map((source) => ({
                  label: source.label,
                  system: null,
                }))
              : 'source' in item
                ? [{ label: item.source.label, system: null }]
                : [],
          observedAt: item.kind === 'stock_position' ? item.observedAt : null,
          sourceUpdatedAt: null,
        }));

        return {
          data: {
            ...list,
            items: list.items.map((item, index) => ({
              ...item,
              cite: citationMarker(references[index]!.kind, item.id),
            })),
            coverage: coverage.coverage,
            evaluationTime: list.asOf,
            instruction:
              'These records match the exact selected filters. Evaluation time does not prove source freshness. Read a record detail before proposing a next action. Procurement stage is not proof of receipt.',
          },
          records: references,
        };
      },
    }),
  );
}
