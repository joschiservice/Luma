import { z } from 'zod';

import { collectionCatalogs } from './collection-catalogs.js';
import {
  type CollectionCondition,
  type CollectionDomain,
  type CollectionGrouping,
  collectionViewStateSchema,
  savedViewDomainSchema,
} from './collections.js';

/** Record lists that saved views of format 1 can describe. */
export const adaptiveViewDomainSchema = z.enum([
  'orders',
  'inventory',
  'fulfillment',
  'customers',
  'products',
  'procurement',
  'issues',
  'decisions',
  'returns',
]);
const scalar = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const field = z.string().min(1).max(120);

/** A governed action offered on a view's rows: a capability or exact published workflow. */
const adaptiveViewActionSchema = z
  .object({
    id: z.string().uuid(),
    label: z
      .object({
        en: z.string().trim().min(1).max(80),
        de: z.string().trim().min(1).max(80),
      })
      .strict(),
    target: z
      .object({
        kind: z.enum(['capability', 'workflow']),
        id: z.string().min(1).max(200),
        version: z.string().max(100).optional(),
      })
      .strict(),
    inputs: z
      .record(
        z.string().min(1).max(100),
        z.discriminatedUnion('source', [
          z.object({ source: z.literal('row'), field }).strict(),
          z.object({ source: z.literal('literal'), value: scalar }).strict(),
        ]),
      )
      .refine((values) => Object.keys(values).length <= 50),
  })
  .strict();

/**
 * Format 1 of a saved view, kept so earlier clients and stored views remain readable. Filters use
 * each record owner's list parameters and columns use its item keys. Upgrade it with
 * `upgradeAdaptiveViewQuery`.
 */
export const adaptiveViewQueryV1Schema = z
  .object({
    version: z.literal(1),
    domain: adaptiveViewDomainSchema,
    filters: z
      .record(z.string().min(1).max(100), scalar)
      .refine((values) => Object.keys(values).length <= 30)
      .default({}),
    customFilters: z
      .array(
        z
          .object({
            fieldId: z.string().uuid(),
            operator: z.enum([
              'eq',
              'ne',
              'gt',
              'gte',
              'lt',
              'lte',
              'contains',
              'is_empty',
            ]),
            value: scalar,
          })
          .strict(),
      )
      .max(20)
      .default([]),
    columns: z.array(field).min(1).max(30),
    sort: z
      .object({ field, direction: z.enum(['asc', 'desc']) })
      .strict()
      .nullable()
      .default(null),
    groupBy: field.nullable().default(null),
    layout: z.enum(['table', 'board']).default('table'),
    metrics: z
      .array(
        z
          .object({
            id: field,
            operation: z.enum(['count', 'sum', 'average']),
            field: field.nullable().default(null),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    charts: z
      .array(
        z
          .object({
            id: field,
            type: z.enum(['bar', 'line']),
            groupBy: field,
            metricId: field,
          })
          .strict(),
      )
      .max(4)
      .default([]),
    actions: z.array(adaptiveViewActionSchema).max(8).default([]),
  })
  .strict()
  .superRefine((query, context) => {
    if (new Set(query.columns).size !== query.columns.length)
      context.addIssue({
        code: 'custom',
        message: 'Columns must be unique',
        path: ['columns'],
      });
    if (
      query.metrics.some(
        (metric) => metric.operation !== 'count' && metric.field === null,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Numeric metrics require a field',
        path: ['metrics'],
      });
    if (
      new Set(query.actions.map((action) => action.id)).size !==
      query.actions.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Action identities must be unique',
        path: ['actions'],
      });
    if (
      new Set(query.charts.map((chart) => chart.id)).size !==
      query.charts.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Chart identities must be unique',
        path: ['charts'],
      });
    if (query.layout === 'board' && !query.groupBy)
      context.addIssue({
        code: 'custom',
        message: 'Board layout requires grouping',
        path: ['groupBy'],
      });
    if (
      new Set(query.metrics.map((metric) => metric.id)).size !==
      query.metrics.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Metrics must have unique identities',
        path: ['metrics'],
      });
    for (const chart of query.charts)
      if (!query.metrics.some((metric) => metric.id === chart.metricId))
        context.addIssue({
          code: 'custom',
          message: 'Chart metric must belong to this query',
          path: ['charts'],
        });
  });

const metricsSchema = adaptiveViewQueryV1Schema.shape.metrics;
const chartsSchema = adaptiveViewQueryV1Schema.shape.charts;
const actionsSchema = adaptiveViewQueryV1Schema.shape.actions;

/**
 * The current saved view format, version 2: a list page's state, as the page shows it, plus
 * optional metrics, charts and governed actions. Field IDs come from the list's catalog. Every
 * response carries this format.
 */
export const adaptiveViewQuerySchema = z
  .object({
    version: z.literal(2),
    domain: savedViewDomainSchema,
    state: collectionViewStateSchema,
    metrics: metricsSchema,
    charts: chartsSchema,
    actions: actionsSchema,
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.metrics.some(
        (metric) => metric.operation !== 'count' && metric.field === null,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Numeric metrics require a field',
        path: ['metrics'],
      });
    for (const [key, ids] of [
      ['metrics', query.metrics.map((metric) => metric.id)],
      ['charts', query.charts.map((chart) => chart.id)],
      ['actions', query.actions.map((action) => action.id)],
    ] as const)
      if (new Set(ids).size !== ids.length)
        context.addIssue({
          code: 'custom',
          message: 'Identities must be unique',
          path: [key],
        });
    for (const chart of query.charts)
      if (!query.metrics.some((metric) => metric.id === chart.metricId))
        context.addIssue({
          code: 'custom',
          message: 'Chart metric must belong to this query',
          path: ['charts'],
        });
  });

/**
 * A saved view as clients may send it: format 2, or format 1 for compatibility. The server
 * upgrades format 1 before validating and storing it.
 */
export const adaptiveViewQueryInputSchema = z.discriminatedUnion('version', [
  adaptiveViewQueryV1Schema,
  adaptiveViewQuerySchema,
]);

export type AdaptiveViewDomain = z.infer<typeof adaptiveViewDomainSchema>;

export type AdaptiveViewQueryV1 = z.infer<typeof adaptiveViewQueryV1Schema>;

export type AdaptiveViewQueryV2 = z.infer<typeof adaptiveViewQuerySchema>;

/** A saved view in the current format. */
export type AdaptiveViewQuery = AdaptiveViewQueryV2;

/** Version 1 field names that differ from the catalog's field IDs, per list. */
const renamed: Partial<Record<string, Record<string, string | null>>> = {
  orders: {
    id: null,
    displayNumber: 'number',
    placedAt: 'placed',
    dueAt: 'due',
    observedAt: 'updated',
    differs: 'comparison',
  },
  inventory: { id: null, skuId: null, locationId: null, unit: null },
  fulfillment: {
    id: null,
    externalId: null,
    unit: null,
    connectionId: 'source',
    estimatedDeliveryAt: 'estimatedDelivery',
    progressAt: 'progress',
    observedAt: 'updated',
  },
  customers: {
    id: null,
    externalId: null,
    displayName: 'name',
    sourceCreatedAt: 'created',
    orderCount: 'orders',
    amountSpent: 'spent',
    sourceUpdatedAt: 'updated',
    observedAt: 'updated',
    connectionId: 'source',
  },
  products: { id: null, skuId: null, skuKey: null, gaps: 'missing' },
  procurement: {
    id: null,
    supplierId: null,
    supplierName: 'supplier',
    attentionKey: 'attention',
    confirmationDueAt: 'confirmationDue',
    nextCheckAt: 'nextCheck',
    createdAt: 'created',
    updatedAt: 'updated',
    connectionId: null,
  },
  issues: { id: null, detectedAt: 'detected', lastActivityAt: 'lastActivity' },
  decisions: { id: null, requestedAt: 'requested' },
};

/**
 * Catalog fields that saved views can filter through the record owner's list parameters before
 * the list catalog offers a filter for them: one value with `any_of`. Maps each catalog field ID
 * to the owner's parameter. Orders and purchase orders run every catalog condition natively and
 * need none.
 */
export const adaptiveViewOwnerFilters: Partial<
  Record<CollectionDomain, Readonly<Record<string, string>>>
> = {
  inventory: { location: 'locationId' },
  fulfillment: { source: 'connectionId', location: 'locationId', kind: 'kind' },
  customers: { state: 'state', source: 'connectionId' },
  products: { missing: 'missingFrom' },
  issues: {
    owner: 'ownerId',
    class: 'class',
    severity: 'severity',
    state: 'state',
  },
  decisions: { domain: 'domain', reason: 'reason' },
};

/** Version 1 list filters that map to a catalog field and operator. */
const filterFields: Partial<
  Record<
    string,
    Record<string, { field: string; op: CollectionCondition['op'] }>
  >
> = {
  orders: {
    status: { field: 'status', op: 'any_of' },
    paymentStatus: { field: 'paymentStatus', op: 'any_of' },
    connectionId: { field: 'source', op: 'any_of' },
    locationId: { field: 'warehouse', op: 'any_of' },
    customerId: { field: 'customer', op: 'any_of' },
    stockBlocked: { field: 'stockBlocked', op: 'is' },
    placedFrom: { field: 'placed', op: 'after' },
    placedBefore: { field: 'placed', op: 'before' },
    updatedFrom: { field: 'updated', op: 'after' },
    updatedBefore: { field: 'updated', op: 'before' },
  },
  procurement: {
    supplierId: { field: 'supplier', op: 'any_of' },
    status: { field: 'status', op: 'any_of' },
    attention: { field: 'attention', op: 'any_of' },
  },
  issues: { ownerId: { field: 'owner', op: 'any_of' } },
};

type CustomOperator = AdaptiveViewQueryV1['customFilters'][number]['operator'];

const customOperators: Record<
  CustomOperator,
  (
    value: string | number | boolean | null,
  ) => Pick<CollectionCondition, 'op' | 'value'>
> = {
  eq: (value) =>
    typeof value === 'number'
      ? { op: 'eq', value }
      : { op: 'is', value: value ?? '' },
  ne: (value) =>
    typeof value === 'number'
      ? { op: 'ne', value }
      : { op: 'is_not', value: value ?? '' },
  gt: (value) => ({ op: 'gt', value: value ?? 0 }),
  gte: (value) => ({ op: 'gte', value: value ?? 0 }),
  lt: (value) => ({ op: 'lt', value: value ?? 0 }),
  lte: (value) => ({ op: 'lte', value: value ?? 0 }),
  contains: (value) => ({ op: 'contains', value: value ?? '' }),
  is_empty: () => ({ op: 'empty' }),
};

/**
 * Upgrades a version 1 view to version 2 without dropping meaning. Filters and columns that
 * have no catalog equivalent keep their names, so the view reports them as needing repair
 * instead of silently showing more records.
 */
export function upgradeAdaptiveViewQuery(
  query: AdaptiveViewQueryV1 | AdaptiveViewQueryV2,
): AdaptiveViewQueryV2 {
  if (query.version === 2) return query;
  const names = renamed[query.domain] ?? {};
  const rename = (name: string) =>
    name.startsWith('custom:')
      ? name
      : names[name] === undefined
        ? name
        : names[name];
  const catalog = collectionCatalogs[query.domain];
  const conditions: CollectionCondition[] = [];
  let segment: string | null = null;
  for (const [key, value] of Object.entries(query.filters)) {
    if (value === null) continue;
    if (key === 'view' && typeof value === 'string') {
      segment = value;
      continue;
    }
    const known = filterFields[query.domain]?.[key];
    const op = known?.op ?? (typeof value === 'boolean' ? 'is' : 'any_of');
    conditions.push({
      field:
        known?.field ??
        (/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) ? key : 'unknown'),
      op,
      value: op === 'any_of' ? [value] : value,
    });
  }
  for (const filter of query.customFilters)
    conditions.push({
      field: `custom:${filter.fieldId}`,
      ...customOperators[filter.operator](filter.value),
    });
  const groupField = query.groupBy ? rename(query.groupBy) : null;
  const dateGroup =
    groupField &&
    catalog.fields.find((item) => item.id === groupField)?.type === 'date';
  const group: CollectionGrouping | null = groupField
    ? {
        field: groupField,
        showEmpty: false,
        ...(dateGroup ? { granularity: 'day' } : {}),
      }
    : null;
  const columns = [
    ...new Set(
      query.columns.map(rename).filter((name): name is string => name !== null),
    ),
  ];

  return adaptiveViewQuerySchema.parse({
    version: 2,
    domain: query.domain,
    state: {
      segment,
      where: { match: 'all', conditions },
      sort: query.sort
        ? {
            field: rename(query.sort.field) ?? query.sort.field,
            direction: query.sort.direction,
          }
        : null,
      group,
      layout: query.layout === 'board' && group ? 'board' : 'table',
      columns: columns.map((id) => ({ id })),
    },
    metrics: query.metrics.map((metric) => ({
      ...metric,
      field: metric.field ? (rename(metric.field) ?? metric.field) : null,
    })),
    charts: query.charts.map((chart) => ({
      ...chart,
      groupBy: rename(chart.groupBy) ?? chart.groupBy,
    })),
    actions: query.actions.map((action) => ({
      ...action,
      inputs: Object.fromEntries(
        Object.entries(action.inputs).map(([name, input]) => [
          name,
          input.source === 'row'
            ? { source: 'row', field: rename(input.field) ?? input.field }
            : input,
        ]),
      ),
    })),
  });
}
