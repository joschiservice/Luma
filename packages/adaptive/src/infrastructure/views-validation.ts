import {
  adaptiveViewDraftSchema,
  adaptiveViewInputSchema,
  adaptiveViewOwnerFilters,
  adaptiveViewPreviewSchema,
  adaptiveViewQueryInputSchema,
  adaptiveViewRevisionSchema,
  adaptiveViewSchema,
  caseQuerySchema,
  collectionCatalogs,
  collectionField,
  type CollectionFieldType,
  collectionGroupIssue,
  collectionSortIssue,
  collectionWhereIssues,
  customerQuerySchema,
  decisionQuerySchema,
  fulfillmentQuerySchema,
  inventoryQuerySchema,
  orderListQuerySchema,
  productQuerySchema,
  purchaseOrderListQuerySchema,
  returnQuerySchema,
  upgradeAdaptiveViewQuery,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { JsonValue, ModelSchema } from '@luma/platform';
import { z } from 'zod';

import type {
  ViewCustomField,
  ViewExecution,
  ViewPermissions,
  ViewQueryIssue,
} from '../application/views.js';
import type { CustomField } from '../domain/fields.js';
import type {
  AdaptiveViewDomain,
  AdaptiveViewDraft,
  AdaptiveViewPreview,
  AdaptiveViewQuery,
  StoredAdaptiveView,
  ViewCondition,
  ViewExecutionQuery,
  ViewReaderDomain,
} from '../domain/views.js';
import { isViewReaderDomain, viewReaderColumns } from '../domain/views.js';

const ownerQueries = {
  orders: orderListQuerySchema,
  inventory: inventoryQuerySchema,
  fulfillment: fulfillmentQuerySchema,
  customers: customerQuerySchema,
  returns: returnQuerySchema,
  products: productQuerySchema,
  procurement: purchaseOrderListQuerySchema,
  issues: caseQuerySchema,
  decisions: decisionQuerySchema.strict(),
};

/**
 * Validates against each owner's vocabulary; unsupported predicates fail before a read. Returns
 * the unparsed parameters, because readers parse them with the same schema and JSON parameters
 * such as `where` parse only once.
 */
function ownerViewQuery(
  query: ViewExecutionQuery,
  cursor?: string,
): Record<string, unknown> {
  if (
    ['cursor', 'limit', 'count', 'sort', 'direction'].some((key) =>
      Object.hasOwn(query.filters, key),
    )
  )
    throw new IdentityError(
      422,
      'VALIDATION_ERROR',
      'Pagination and sorting belong to the query controls.',
    );
  const schema = ownerQueries[query.domain];
  const raw: Record<string, unknown> = { ...query.filters };
  if (query.sort) {
    raw.sort = query.sort.field;
    raw.direction = query.sort.direction;
  }
  if (cursor) raw.cursor = cursor;
  if (query.domain === 'orders' || query.domain === 'procurement')
    raw.count = 'exact';
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new IdentityError(
      422,
      'VALIDATION_ERROR',
      'This list does not support one of the requested filters or sort fields.',
    );

  return raw;
}

function jsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]),
    );
  throw new Error('Invalid JSON schema');
}

const draftSchema = adaptiveViewDraftSchema.omit({ preview: true });
const rawJson = z.toJSONSchema(draftSchema);

export const viewDraftModelSchema: ModelSchema<
  Omit<AdaptiveViewDraft, 'preview'>
> = {
  name: 'adaptive_view_draft',
  jsonSchema: Object.fromEntries(
    Object.entries(rawJson).map(([key, value]) => [key, jsonValue(value)]),
  ),
  parse: (value) => draftSchema.parse(value),
};

function refuse(message: string): never {
  throw new IdentityError(422, 'VALIDATION_ERROR', message);
}

const customFieldTypes: Record<CustomField['type'], CollectionFieldType> = {
  text: 'text',
  number: 'number',
  date: 'date',
  boolean: 'boolean',
  single_choice: 'enum',
  multi_choice: 'tags',
  person: 'person',
};

/** Lists whose owner runs every catalog condition natively through its `where` parameter. */
const conditionLists = new Set<AdaptiveViewDomain>([
  'orders',
  'products',
  'inventory',
  'fulfillment',
  'returns',
  'customers',
  'procurement',
  'issues',
  'decisions',
]);

/**
 * Built-in purchase-order views beside All: the purchase-order list reads them through its
 * `stage` parameter, as the Procurement page does.
 */
const procurementStageViews = new Set([
  'attention',
  'awaiting_confirmation',
  'draft',
]);

/** Owner sort parameters whose names differ from the catalog field. */
const ownerSorts: Partial<Record<ViewReaderDomain, Record<string, string>>> = {
  customers: { spent: 'amountSpent' },
};

/** The owner parameter for a condition the owner can run exactly: `any_of` one text value. */
function ownerFilter(domain: AdaptiveViewDomain, condition: ViewCondition) {
  const key = adaptiveViewOwnerFilters[domain]?.[condition.field];
  const value = Array.isArray(condition.value) ? condition.value : [];

  return key &&
    condition.op === 'any_of' &&
    value.length === 1 &&
    typeof value[0] === 'string'
    ? { key, value: value[0] }
    : null;
}

function readerKey(domain: ViewReaderDomain, id: string): string | undefined {
  return id === 'id' || id.startsWith('custom:')
    ? id
    : viewReaderColumns[domain][id];
}

/** Whether the view engine can group or aggregate this field from its reader rows. */
function engineField(domain: AdaptiveViewDomain, id: string) {
  return (
    isViewReaderDomain(domain) &&
    !id.startsWith('custom:') &&
    Object.hasOwn(viewReaderColumns[domain], id)
  );
}

/**
 * Checks a saved view against its list catalog: segment, conditions, sorting, grouping and the
 * fields of metrics and charts. Columns are not checked; unknown columns show as unavailable.
 * Conditions may also use the owner filters the view engine runs exactly.
 */
function queryIssues(
  query: AdaptiveViewQuery,
  options: {
    permissions: ViewPermissions;
    customFields: readonly ViewCustomField[];
  },
): ViewQueryIssue[] {
  const catalog = collectionCatalogs[query.domain];
  const { state } = query;
  const customIds = new Set(options.customFields.map((field) => field.id));
  const issues: ViewQueryIssue[] = [];
  const invalid = (subject: string, message: string) =>
    issues.push({ message: `${subject}: ${message}.`, forbidden: false });
  const permitted = (subject: string, id: string) => {
    const permission = collectionField(catalog, id)?.permission;
    if (permission && !options.permissions.has(permission))
      issues.push({
        message: `${subject}: Your role cannot use this field.`,
        forbidden: true,
      });
  };

  if (state.segment !== null && !catalog.segments.includes(state.segment))
    invalid(state.segment, 'This list has no such built-in view');
  state.where.conditions.forEach((condition) =>
    permitted(condition.field, condition.field),
  );
  const conditionIssues = collectionWhereIssues(catalog, state.where, {
    customFieldTypes: new Map(
      options.customFields.map((field) => [
        field.id,
        customFieldTypes[field.type],
      ]),
    ),
  });
  for (const issue of conditionIssues) {
    const condition =
      issue.index === null ? undefined : state.where.conditions[issue.index];
    if (
      condition &&
      !collectionField(catalog, condition.field)?.filter &&
      ownerFilter(query.domain, condition)
    )
      continue;
    invalid(condition?.field ?? 'Conditions', issue.message);
  }
  if (state.sort) {
    const problem = collectionSortIssue(catalog, state.sort.field, customIds);
    if (problem) invalid(state.sort.field, problem);
    permitted(state.sort.field, state.sort.field);
  }
  if (state.group) {
    const { field, granularity } = state.group;
    if (field.startsWith('custom:')) {
      if (!customIds.has(field.slice(7)))
        invalid(field, 'This custom field is unavailable');
      else if (granularity) invalid(field, 'Only dates group by period');
    } else {
      const problem = collectionGroupIssue(catalog, field, granularity);
      if (problem && (granularity || !engineField(query.domain, field)))
        invalid(field, problem);
      permitted(field, field);
    }
  }
  for (const field of [
    ...query.metrics.flatMap((metric) => (metric.field ? [metric.field] : [])),
    ...query.charts.map((chart) => chart.groupBy),
  ])
    if (
      field.startsWith('custom:')
        ? !customIds.has(field.slice(7))
        : !engineField(query.domain, field)
    )
      invalid(field, 'Metrics and charts can only use columns this view reads');

  return issues;
}

type CustomFilter = ViewExecutionQuery['customFilters'][number];

function isRange(
  value: ViewCondition['value'],
): value is Extract<ViewCondition['value'], { from: unknown }> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'from' in value &&
    'to' in value
  );
}

function scalar(value: unknown): string | number | boolean | undefined {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? value
    : undefined;
}

/** Compiles a custom field condition to the engine's predicates, or refuses it. */
function customFilters(
  condition: ViewCondition,
  type: CustomField['type'] | undefined,
): CustomFilter[] {
  const fieldId = condition.field.slice(7);
  const filter = (
    operator: CustomFilter['operator'],
    value: CustomFilter['value'],
  ): CustomFilter => ({ fieldId, operator, value });
  const { op, value } = condition;
  const one = scalar(value);
  const list = Array.isArray(value) ? value.map(scalar) : [];
  const listed = list.every((item) => item !== undefined) ? list : [];
  if (op === 'empty') return [filter('is_empty', null)];
  if (one !== undefined) {
    if (op === 'is' || op === 'eq') return [filter('eq', one)];
    if (op === 'is_not' || op === 'ne') return [filter('ne', one)];
    if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte')
      return [filter(op, one)];
    if (op === 'before') return [filter('lt', one)];
    if (op === 'after') return [filter('gt', one)];
    if (op === 'contains' && type === 'text') return [filter('contains', one)];
  }
  if (type === 'multi_choice' && (op === 'all_of' || op === 'any_of')) {
    if (op === 'all_of' || listed.length === 1)
      return listed.map((item) => filter('contains', item ?? null));
  } else if (op === 'any_of' && listed.length === 1)
    return [filter('eq', listed[0] ?? null)];
  if (op === 'between' && isRange(value)) {
    const from = scalar(value.from),
      to = scalar(value.to);
    if (
      (value.from === null || from !== undefined) &&
      (value.to === null || to !== undefined)
    )
      return [
        ...(from === undefined ? [] : [filter('gte', from)]),
        ...(to === undefined ? [] : [filter('lte', to)]),
      ];
  }

  return refuse(
    `Saved views can't yet use this condition on ${condition.field}.`,
  );
}

/**
 * Compiles a saved view into the view engine's query: the segment and conditions become owner
 * parameters, custom field conditions become engine predicates, and catalog IDs become reader
 * item keys. Orders, products, inventory, fulfillment, returns, customers, purchase orders,
 * issues and Needs you run catalog conditions natively through `where`; other lists run only
 * the conditions their owner parameters express exactly. Refuses anything else with 422.
 */
function executionQuery(
  query: AdaptiveViewQuery,
  customFields: readonly ViewCustomField[],
): ViewExecution {
  const { domain, state } = query;
  if (!isViewReaderDomain(domain))
    return refuse(
      "Saved views can't yet preview this list. Open the view from its list page.",
    );
  const filters: ViewExecutionQuery['filters'] = {};
  // Customers have a single built-in view and no owner view parameter; purchase-order views
  // are stages of the list.
  if (domain === 'customers' || domain === 'procurement') {
    if (
      domain === 'procurement' &&
      procurementStageViews.has(state.segment ?? '')
    )
      filters.stage = state.segment;
    else if (state.segment && state.segment !== 'all')
      refuse(`This list has no built-in view named ${state.segment}.`);
  } else if (state.segment) filters.view = state.segment;
  const custom = state.where.conditions.filter((condition) =>
    condition.field.startsWith('custom:'),
  );
  const native = state.where.conditions.filter(
    (condition) => !condition.field.startsWith('custom:'),
  );
  if (
    state.where.match === 'any' &&
    state.where.conditions.length > 1 &&
    (custom.length > 0 || !conditionLists.has(domain))
  )
    refuse(
      "This view can't yet match any one of these conditions. Match all conditions instead.",
    );
  if (conditionLists.has(domain) && native.length)
    filters.where = JSON.stringify({
      match: state.where.match,
      conditions: native,
    });
  else
    for (const condition of native) {
      const owner = ownerFilter(domain, condition);
      if (!owner) refuse(`This list can't yet filter by ${condition.field}.`);
      if (Object.hasOwn(filters, owner.key))
        refuse(`This list can't yet combine conditions on ${condition.field}.`);
      filters[owner.key] = owner.value;
    }
  const types = new Map(customFields.map((field) => [field.id, field.type]));
  const field = (id: string) =>
    readerKey(domain, id) ?? refuse(`This view can't yet read ${id}.`);
  let groupBy: string | null = null;
  if (state.group) {
    if (state.group.granularity)
      refuse(
        `Saved views can't yet group ${state.group.field} by period. Open the view from its list page.`,
      );
    groupBy = field(state.group.field);
  }
  const requested = state.columns.length
    ? state.columns.map((column) => column.id)
    : [...collectionCatalogs[domain].defaultColumns];
  const columns = requested.map((id) => ({
    id,
    key: readerKey(domain, id) ?? null,
  }));

  return {
    query: {
      version: 1,
      domain,
      filters,
      customFilters: custom.flatMap((condition) =>
        customFilters(condition, types.get(condition.field.slice(7))),
      ),
      columns: [
        'id',
        ...columns.flatMap((column) => (column.key ? [column.key] : [])),
      ],
      sort: state.sort && {
        field: state.sort.field.startsWith('custom:')
          ? state.sort.field
          : (ownerSorts[domain]?.[state.sort.field] ?? state.sort.field),
        direction: state.sort.direction,
      },
      groupBy,
      layout: groupBy && state.layout === 'board' ? 'board' : 'table',
      metrics: query.metrics.map((metric) => ({
        ...metric,
        field: metric.field && field(metric.field),
      })),
      charts: query.charts.map((chart) => ({
        ...chart,
        groupBy: field(chart.groupBy),
      })),
      actions: query.actions,
    },
    columns,
  };
}

/**
 * Describes the lists a model may use for a draft: segments, columns, conditions and sorts the
 * view engine runs. Lists whose API takes `where` offer every catalog condition; other lists
 * offer only their exact owner filters, one `any_of` value each.
 */
function describeLists(
  domains: readonly ViewReaderDomain[],
  permissions: ViewPermissions,
) {
  return Object.fromEntries(
    domains.map((domain) => {
      const catalog = collectionCatalogs[domain];
      const native = conditionLists.has(domain);
      const usable = catalog.fields.filter(
        (field) => !field.permission || permissions.has(field.permission),
      );
      const owner = Object.keys(adaptiveViewOwnerFilters[domain] ?? {}).filter(
        (id) =>
          !native &&
          (!collectionField(catalog, id) ||
            usable.some((field) => field.id === id)),
      );

      return [
        domain,
        {
          segments: catalog.segments,
          columns: Object.keys(viewReaderColumns[domain]),
          conditions: [
            ...usable.flatMap((field) =>
              native && field.filter
                ? [
                    {
                      field: field.id,
                      type: field.type,
                      operators: field.filter,
                      ...(field.options ? { options: field.options } : {}),
                      ...(field.optionSource
                        ? { identities: field.optionSource }
                        : {}),
                    },
                  ]
                : [],
            ),
            ...owner.map((id) => ({
              field: id,
              operators: ['any_of'],
              values: 'exactly one',
            })),
          ],
          sort: usable.flatMap((field) => (field.sort ? [field.id] : [])),
        },
      ];
    }),
  );
}

/** Parses a query in format 1 or 2 and returns it in format 2. */
function parseQuery(value: unknown): AdaptiveViewQuery {
  return upgradeAdaptiveViewQuery(adaptiveViewQueryInputSchema.parse(value));
}

export const viewsValidation = {
  query: parseQuery,
  input: (value: unknown) => {
    const input = adaptiveViewInputSchema.parse(value);

    return { ...input, query: upgradeAdaptiveViewQuery(input.query) };
  },
  preview: (value: unknown): AdaptiveViewPreview =>
    adaptiveViewPreviewSchema.parse(value),
  prompt: (value: unknown): string =>
    z.string().trim().min(1).max(2000).parse(value),
  ownerQuery: ownerViewQuery,
  issues: queryIssues,
  execution: executionQuery,
  describe: describeLists,
};

const storedViewSchema = adaptiveViewSchema
  .omit({ canEdit: true })
  .extend({ query: adaptiveViewQueryInputSchema });

/** Validates a stored view, upgrading a format 1 query, without granting presentation permissions. */
export function parseStoredView(value: unknown): StoredAdaptiveView {
  const view = storedViewSchema.parse(value);

  return { ...view, query: upgradeAdaptiveViewQuery(view.query) };
}

/** Validates one immutable saved-query revision, upgrading a format 1 query. */
export function parseViewRevision(value: unknown) {
  const revision = adaptiveViewRevisionSchema
    .extend({ query: adaptiveViewQueryInputSchema })
    .parse(value);

  return { ...revision, query: upgradeAdaptiveViewQuery(revision.query) };
}
