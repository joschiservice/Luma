import type {
  CollectionCondition,
  CollectionDomain,
  CollectionFieldType,
  CollectionGranularity,
  CollectionLayout,
  CollectionOperator,
  CollectionSort,
  CollectionWhere,
} from './collections.js';

/** Where a field's value comes from, shown next to columns so people can weigh it. */
type CollectionFieldOrigin = 'source' | 'luma' | 'derived';

/**
 * Options the client loads at run time rather than from the catalog, such as the workspace's
 * connections or members. `systems` are the provider systems of its connections, such as
 * `shopify`.
 */
export type CollectionOptionSource =
  | 'connections'
  | 'locations'
  | 'members'
  | 'suppliers'
  | 'customers'
  | 'mailboxes'
  | 'roles'
  | 'systems';

/**
 * One field of a list. Labels and option names live in the web message catalogs under the
 * domain and field ID; the catalog only describes behavior, so server and client agree.
 */
export interface CollectionFieldDefinition {
  readonly id: string;
  readonly type: CollectionFieldType;
  readonly origin: CollectionFieldOrigin;
  /** Operators the list API accepts for this field; omitted when it cannot be filtered. */
  readonly filter?: readonly CollectionOperator[];
  /** The list API accepts this field as `sort`. */
  readonly sort?: true;
  /** The list API can group by this field; dates list their granularities. */
  readonly group?: true | readonly CollectionGranularity[];
  /** The page can show this field as a column or row property. */
  readonly column?: true;
  /** A quick filter shown as a pill even when unset. */
  readonly quick?: true;
  readonly options?: readonly string[];
  readonly optionSource?: CollectionOptionSource;
  /**
   * Every source reports its own value; conditions may name a source scope. Without one a
   * condition matches when any source's value does. `lowest` applies to quantities only.
   */
  readonly perSource?: true;
  /** An additional permission needed to see, filter or sort by this field. */
  readonly permission?: string;
}

export interface CollectionCatalog {
  readonly domain: CollectionDomain;
  /** Permission needed to read the list. */
  readonly permission: string;
  /** Built-in views, in display order; the first is the default. */
  readonly segments: readonly string[];
  readonly defaultSort: CollectionSort | null;
  readonly defaultColumns: readonly string[];
  readonly layouts: readonly CollectionLayout[];
  /** Record type whose custom fields this list can show, filter and sort. */
  readonly customFields?:
    'order' | 'product' | 'supplier' | 'purchase_order' | 'customer';
  /**
   * `url`: search text may appear in the URL. `private`: it may match personal data, so it
   * stays in page state only. `none`: the list has no search.
   */
  readonly search: 'url' | 'private' | 'none';
  readonly fields: readonly CollectionFieldDefinition[];
}

const choice = ['any_of', 'none_of', 'empty', 'not_empty'] as const;
const quantity = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'empty',
  'not_empty',
] as const;
const moment = [
  'before',
  'after',
  'between',
  'within_last',
  'within_next',
  'empty',
  'not_empty',
] as const;

/** The default operators for each field type. */
export const collectionOperators: Record<
  CollectionFieldType,
  readonly CollectionOperator[]
> = {
  text: ['contains', 'not_contains', 'is', 'is_not', 'empty', 'not_empty'],
  enum: choice,
  tags: ['any_of', 'all_of', 'none_of', 'empty', 'not_empty'],
  number: quantity,
  money: quantity,
  date: moment,
  boolean: ['is'],
  person: choice,
  reference: choice,
};

const dates = ['day', 'week', 'month'] as const;

export const ordersCatalog: CollectionCatalog = {
  domain: 'orders',
  permission: 'orders.read',
  segments: ['all', 'outstanding', 'overdue', 'needs_you', 'differs', 'stuck'],
  defaultSort: { field: 'updated', direction: 'desc' },
  defaultColumns: [
    'number',
    'placed',
    'status',
    'fulfillment',
    'total',
    'sources',
    'updated',
  ],
  layouts: ['table', 'list', 'board'],
  customFields: 'order',
  search: 'private',
  fields: [
    { id: 'number', type: 'text', origin: 'source', sort: true, column: true },
    {
      id: 'placed',
      type: 'date',
      origin: 'source',
      filter: collectionOperators.date,
      sort: true,
      group: dates,
      column: true,
    },
    {
      id: 'updated',
      type: 'date',
      origin: 'source',
      filter: collectionOperators.date,
      sort: true,
      column: true,
    },
    {
      id: 'due',
      type: 'date',
      origin: 'source',
      filter: collectionOperators.date,
      sort: true,
      group: dates,
      column: true,
    },
    {
      id: 'status',
      type: 'enum',
      origin: 'source',
      options: ['open', 'completed', 'cancelled', 'unknown'],
      filter: choice,
      sort: true,
      group: true,
      column: true,
      quick: true,
    },
    {
      id: 'paymentStatus',
      type: 'enum',
      origin: 'source',
      options: [
        'pending',
        'authorized',
        'paid',
        'partially_refunded',
        'refunded',
        'failed',
        'unknown',
      ],
      filter: choice,
      sort: true,
      group: true,
      column: true,
      quick: true,
    },
    {
      id: 'fulfillment',
      type: 'enum',
      origin: 'derived',
      options: [
        'unfulfilled',
        'partial',
        'fulfilled',
        'not_required',
        'no_lines',
      ],
      filter: choice,
      sort: true,
      group: true,
      column: true,
    },
    {
      id: 'total',
      type: 'money',
      origin: 'source',
      filter: quantity,
      sort: true,
      column: true,
    },
    {
      id: 'lineCount',
      type: 'number',
      origin: 'source',
      filter: quantity,
      sort: true,
      column: true,
    },
    {
      id: 'source',
      type: 'reference',
      origin: 'source',
      optionSource: 'connections',
      filter: ['any_of', 'none_of'],
      group: true,
      quick: true,
    },
    { id: 'sources', type: 'reference', origin: 'source', column: true },
    {
      id: 'comparison',
      type: 'enum',
      origin: 'derived',
      options: ['matching', 'pending', 'confirmed', 'inconclusive'],
      filter: choice,
      group: true,
      column: true,
    },
    {
      id: 'overdue',
      type: 'boolean',
      origin: 'derived',
      filter: ['is'],
      group: true,
      column: true,
    },
    {
      id: 'needsYou',
      type: 'boolean',
      origin: 'derived',
      filter: ['is'],
      group: true,
    },
    { id: 'hasIssue', type: 'boolean', origin: 'derived', filter: ['is'] },
    {
      id: 'warehouse',
      type: 'reference',
      origin: 'source',
      optionSource: 'locations',
      filter: ['any_of', 'none_of'],
      group: true,
      quick: true,
      permission: 'fulfillment.read',
    },
    {
      id: 'stockBlocked',
      type: 'boolean',
      origin: 'source',
      filter: ['is'],
      permission: 'inventory.read',
    },
    {
      id: 'customer',
      type: 'reference',
      origin: 'source',
      optionSource: 'customers',
      filter: ['any_of'],
      permission: 'customers.read',
    },
    {
      id: 'channel',
      type: 'text',
      origin: 'source',
      filter: collectionOperators.text,
      group: true,
      column: true,
    },
    {
      id: 'tags',
      type: 'tags',
      origin: 'source',
      filter: collectionOperators.tags,
      group: true,
      column: true,
    },
    {
      id: 'discountCode',
      type: 'tags',
      origin: 'source',
      filter: collectionOperators.tags,
    },
    {
      id: 'shippingMethod',
      type: 'tags',
      origin: 'source',
      filter: collectionOperators.tags,
      group: true,
    },
    {
      id: 'currency',
      type: 'text',
      origin: 'source',
      filter: ['is', 'is_not', 'empty', 'not_empty'],
      group: true,
    },
    {
      id: 'test',
      type: 'boolean',
      origin: 'source',
      filter: ['is'],
      group: true,
      column: true,
    },
    {
      id: 'cancelReason',
      type: 'enum',
      origin: 'source',
      options: [
        'customer',
        'declined',
        'fraud',
        'inventory',
        'staff',
        'other',
        'unknown',
      ],
      filter: choice,
      group: true,
    },
    {
      id: 'country',
      type: 'text',
      origin: 'source',
      filter: ['any_of', 'none_of'],
      permission: 'customers.read',
    },
  ],
};

/** Finds a field, or undefined for custom fields and unknown IDs. */
export function collectionField(
  catalog: CollectionCatalog,
  id: string,
): CollectionFieldDefinition | undefined {
  return catalog.fields.find((field) => field.id === id);
}

export interface CollectionIssue {
  index: number | null;
  message: string;
}

const listOperators = new Set<CollectionOperator>([
  'any_of',
  'none_of',
  'all_of',
]);
const valueless = new Set<CollectionOperator>([
  'empty',
  'not_empty',
  'unknown',
]);

function isRange(value: unknown): value is { from: unknown; to: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'from' in value &&
    'to' in value
  );
}

function isRelative(value: unknown): value is { amount: number; unit: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'unit' in value &&
    'amount' in value &&
    typeof value.amount === 'number'
  );
}

function isMoney(
  value: unknown,
): value is { amount: string; currency: string } {
  return typeof value === 'object' && value !== null && 'currency' in value;
}

/** Checks one condition's value shape against its operator and field type. */
function valueIssue(
  type: CollectionFieldType | 'custom',
  condition: CollectionCondition,
): string | null {
  const { op, value } = condition;
  if (valueless.has(op))
    return value === undefined ? null : 'This operator takes no value';
  if (value === undefined) return 'This operator needs a value';
  if (listOperators.has(op))
    return Array.isArray(value) ? null : 'This operator needs a list of values';
  if (Array.isArray(value)) return 'This operator takes a single value';
  if (op === 'between')
    return isRange(value) ? null : 'A range needs a start or an end';
  if (op === 'within_last' || op === 'within_next')
    return isRelative(value)
      ? null
      : 'A relative period needs an amount and unit';
  if (type === 'money' && ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(op))
    return isMoney(value) ? null : 'Amounts need a currency';
  if (type === 'boolean')
    return typeof value === 'boolean' ? null : 'Expected true or false';
  if (type === 'number' && ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(op))
    return typeof value === 'number' ? null : 'Expected a number';

  return null;
}

/**
 * Validates conditions against a catalog. Custom fields (`custom:<id>`) are accepted only when
 * the list supports custom fields and `customFieldTypes` names the field; the server passes the
 * current, readable field definitions. `permissions` hides fields the reader cannot use.
 */
export function collectionWhereIssues(
  catalog: CollectionCatalog,
  where: CollectionWhere,
  options: {
    permissions?: ReadonlySet<string>;
    customFieldTypes?: ReadonlyMap<string, CollectionFieldType>;
  } = {},
): CollectionIssue[] {
  const issues: CollectionIssue[] = [];
  where.conditions.forEach((condition, index) => {
    if (condition.field.startsWith('custom:')) {
      const type = catalog.customFields
        ? options.customFieldTypes?.get(condition.field.slice(7))
        : undefined;
      if (!type) {
        issues.push({ index, message: 'This custom field is unavailable' });

        return;
      }
      if (!collectionOperators[type].includes(condition.op)) {
        issues.push({
          index,
          message: 'This field does not support this operator',
        });

        return;
      }
      const problem = valueIssue(type, condition);
      if (problem) issues.push({ index, message: problem });

      return;
    }
    const field = collectionField(catalog, condition.field);
    if (!field?.filter) {
      issues.push({ index, message: 'This field cannot be filtered' });

      return;
    }
    if (
      field.permission &&
      options.permissions &&
      !options.permissions.has(field.permission)
    ) {
      issues.push({ index, message: 'Your role cannot filter by this field' });

      return;
    }
    if (!field.filter.includes(condition.op)) {
      issues.push({
        index,
        message: 'This field does not support this operator',
      });

      return;
    }
    if (condition.source && !field.perSource) {
      issues.push({
        index,
        message: 'This field has one value for all sources',
      });

      return;
    }
    if (condition.source === 'lowest' && field.type !== 'number') {
      issues.push({
        index,
        message: 'Only quantities can use the lowest value of all sources',
      });

      return;
    }
    const problem = valueIssue(field.type, condition);
    if (problem) issues.push({ index, message: problem });
    else if (
      field.options &&
      Array.isArray(condition.value) &&
      condition.value.some(
        (value) => typeof value === 'string' && !field.options?.includes(value),
      )
    )
      issues.push({
        index,
        message: 'This value is not one of the field’s options',
      });
  });

  return issues;
}

/** Validates a sort field against a catalog; custom fields need the list's custom-field support. */
export function collectionSortIssue(
  catalog: CollectionCatalog,
  field: string,
  customFieldIds?: ReadonlySet<string>,
): string | null {
  if (field.startsWith('custom:'))
    return catalog.customFields && customFieldIds?.has(field.slice(7))
      ? null
      : 'This custom field is unavailable';

  return collectionField(catalog, field)?.sort
    ? null
    : 'This field cannot be sorted';
}

/** Validates a grouping field and granularity against a catalog. */
export function collectionGroupIssue(
  catalog: CollectionCatalog,
  field: string,
  granularity?: CollectionGranularity,
): string | null {
  const definition = collectionField(catalog, field);
  if (!definition?.group) return 'This field cannot be grouped';
  if (definition.type === 'date')
    return granularity &&
      Array.isArray(definition.group) &&
      definition.group.includes(granularity)
      ? null
      : 'Date groups need a day, week or month';

  return granularity ? 'Only dates group by period' : null;
}

/**
 * The first problem of a list request's conditions or grouping, worded as list APIs report it
 * ("Condition 2: This field cannot be filtered."), or null when the catalog allows both. List
 * APIs answer such problems with 400; field permissions are checked separately.
 */
export function collectionQueryIssue(
  catalog: CollectionCatalog,
  query: {
    where?: CollectionWhere | undefined;
    group?:
      | { field: string; granularity?: CollectionGranularity | undefined }
      | undefined;
  },
): string | null {
  const issue = query.where
    ? collectionWhereIssues(catalog, query.where)[0]
    : undefined;
  const message = issue
    ? `Condition ${(issue.index ?? 0) + 1}: ${issue.message}`
    : query.group
      ? collectionGroupIssue(
          catalog,
          query.group.field,
          query.group.granularity,
        )
      : null;

  return message && (message.endsWith('.') ? message : `${message}.`);
}
