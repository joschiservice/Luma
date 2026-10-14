import type { ViewAction } from './actions.js';

/** Record lists the view engine can read: format 1 domains. */
export type ViewReaderDomain =
  | 'orders'
  | 'inventory'
  | 'fulfillment'
  | 'customers'
  | 'products'
  | 'procurement'
  | 'issues'
  | 'decisions'
  | 'returns';

/** Record lists a saved view can describe; each is one list page. */
export type AdaptiveViewDomain =
  ViewReaderDomain | 'transfers' | 'suppliers' | 'inbox' | 'activity';

type ViewScalar = string | number | boolean | null;

interface ViewMetric {
  id: string;
  operation: 'count' | 'sum' | 'average';
  field: string | null;
}

interface ViewChart {
  id: string;
  type: 'bar' | 'line';
  groupBy: string;
  metricId: string;
}

/**
 * Format 1 of a saved view. It is also the shape the view engine runs: owner list parameters as
 * `filters`, custom field predicates, and reader item keys for columns, sorting and grouping.
 */
export interface AdaptiveViewQueryV1 {
  version: 1;
  domain: ViewReaderDomain;
  filters: Record<string, ViewScalar>;
  customFilters: {
    fieldId: string;
    operator:
      'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'is_empty';
    value: ViewScalar;
  }[];
  columns: string[];
  sort: { field: string; direction: 'asc' | 'desc' } | null;
  groupBy: string | null;
  layout: 'table' | 'board';
  metrics: ViewMetric[];
  charts: ViewChart[];
  actions: ViewAction[];
}

/** A query compiled for the view engine from a saved view; never stored or returned. */
export type ViewExecutionQuery = AdaptiveViewQueryV1;

type ViewConditionOperator =
  | 'is'
  | 'is_not'
  | 'any_of'
  | 'none_of'
  | 'all_of'
  | 'contains'
  | 'not_contains'
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'before'
  | 'after'
  | 'within_last'
  | 'within_next'
  | 'empty'
  | 'not_empty'
  | 'unknown';

type ConditionScalar = string | number | boolean;

type DynamicValue = { dynamic: 'me' | 'today' };

type MoneyValue = { amount: string; currency: string };

type RangeBound = ConditionScalar | MoneyValue | DynamicValue | null;

type ViewConditionValue =
  | ConditionScalar
  | DynamicValue
  | { amount: number; unit: 'day' | 'week' | 'month' }
  | MoneyValue
  | { from: RangeBound; to: RangeBound }
  | (ConditionScalar | DynamicValue)[];

/** One condition of a list: a catalog field ID or `custom:<id>`, operator and value. */
export interface ViewCondition {
  field: string;
  op: ViewConditionOperator;
  value?: ViewConditionValue | undefined;
  source?: string | undefined;
}

/** A list page's shareable state, as the list catalog describes it. */
interface ViewState {
  segment: string | null;
  where: { match: 'all' | 'any'; conditions: ViewCondition[] };
  sort: { field: string; direction: 'asc' | 'desc' } | null;
  group: {
    field: string;
    granularity?: 'day' | 'week' | 'month' | undefined;
    showEmpty: boolean;
  } | null;
  layout: 'table' | 'list' | 'board';
  density: 'comfortable' | 'compact';
  columns: { id: string; width?: number | undefined }[];
  properties: string[];
  preview: boolean;
}

/**
 * Format 2 of a saved view, the only format stored and returned: a list page's state with field
 * IDs from the list catalog, plus optional metrics, charts and governed actions.
 */
export interface AdaptiveViewQuery {
  version: 2;
  domain: AdaptiveViewDomain;
  state: ViewState;
  metrics: ViewMetric[];
  charts: ViewChart[];
  actions: ViewAction[];
}

/** A reviewed view to save; format 1 queries are upgraded before validation. */
export interface AdaptiveViewInput {
  commandId: string;
  name: string;
  description: string;
  sharing: { scope: 'private' | 'workspace' | 'roles'; roleIds: string[] };
  query: AdaptiveViewQuery | AdaptiveViewQueryV1;
  reviewed: true;
}

export interface StoredAdaptiveView {
  name: string;
  description: string;
  sharing: AdaptiveViewInput['sharing'];
  query: AdaptiveViewQuery;
  id: string;
  tenantId: string;
  ownerId: string;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdaptiveView extends StoredAdaptiveView {
  canEdit: boolean;
}

export interface AdaptiveViewRevision extends StoredAdaptiveView {
  changedBy: string;
}

export interface AdaptiveViewPreview {
  items: Record<string, unknown>[];
  nextCursor: string | null;
  asOf: string;
  totalCount: number | null;
  warnings: string[];
  availableColumns: string[];
  groups: { key: unknown; count: number }[];
  chartSeries: {
    id: string;
    points: { key: unknown; value: number | null; count: number }[];
    truncated: boolean;
    complete: boolean;
  }[];
  aggregates: { metricId: string; value: number | null; complete: boolean }[];
}

export interface AdaptiveViewDraft {
  status: 'ready' | 'needs_clarification' | 'unsupported' | 'unavailable';
  query: AdaptiveViewQuery | null;
  explanation: string;
  warnings: string[];
  preview: AdaptiveViewPreview | null;
}

export type ViewHistory = { items: AdaptiveViewRevision[]; truncated: boolean };

/** Live personal views each member may keep. */
export const personalViewLimit = 50;

/** Live views a workspace may share with the workspace or roles. */
export const sharedViewLimit = 200;

/** Permission needed to read each list, as its catalog states. */
export const viewPermissions: Record<AdaptiveViewDomain, string> = {
  orders: 'orders.read',
  inventory: 'inventory.read',
  fulfillment: 'fulfillment.read',
  customers: 'customers.read',
  products: 'products.read',
  procurement: 'procurement.read',
  issues: 'issues.read',
  decisions: 'issues.read',
  transfers: 'inventory.read',
  returns: 'returns.read',
  suppliers: 'procurement.read',
  inbox: 'messages.read',
  activity: 'activity.read',
};

/**
 * The item key each view reader returns for a catalog column. Previews compile catalog IDs to
 * these keys and key their rows by catalog ID again; a column missing here is unavailable.
 */
export const viewReaderColumns: Record<
  ViewReaderDomain,
  Readonly<Record<string, string>>
> = {
  orders: {
    number: 'displayNumber',
    placed: 'placedAt',
    updated: 'observedAt',
    due: 'dueAt',
    status: 'status',
    paymentStatus: 'paymentStatus',
    fulfillment: 'fulfillment',
    total: 'total',
    lineCount: 'lineCount',
    comparison: 'comparisonState',
    overdue: 'overdue',
  },
  inventory: {
    sku: 'sku',
    location: 'location',
    sources: 'sources',
    differences: 'differences',
    sync: 'sync',
  },
  fulfillment: {
    order: 'order',
    kind: 'kind',
    source: 'connectionId',
    status: 'status',
    signals: 'signals',
    holds: 'holds',
    location: 'location',
    method: 'method',
    fulfillAt: 'fulfillAt',
    fulfillBy: 'fulfillBy',
    estimatedDelivery: 'estimatedDeliveryAt',
    progress: 'progressAt',
    units: 'units',
    updated: 'observedAt',
  },
  customers: {
    name: 'displayName',
    email: 'email',
    phone: 'phone',
    state: 'state',
    source: 'connectionId',
    created: 'sourceCreatedAt',
    updated: 'sourceUpdatedAt',
    orders: 'orderCount',
    spent: 'amountSpent',
    tags: 'tags',
  },
  products: {
    sku: 'sku',
    title: 'title',
    listings: 'listings',
    differences: 'differences',
    missing: 'gaps',
  },
  // `attention` is the key of one open item, so row actions such as a supplier follow-up can
  // name it; the list's conditions and groups use the item kinds.
  procurement: {
    reference: 'reference',
    number: 'number',
    supplier: 'supplierName',
    status: 'status',
    stage: 'stage',
    attention: 'attentionKey',
    expected: 'expectedDate',
    confirmationDue: 'confirmationDueAt',
    nextCheck: 'nextCheckAt',
    nextOwner: 'nextOwner',
    lines: 'lines',
    created: 'createdAt',
    updated: 'updatedAt',
    authority: 'authority',
    location: 'locationIds',
    sku: 'skus',
    value: 'value',
  },
  issues: {
    summary: 'summary',
    class: 'class',
    state: 'state',
    severity: 'severity',
    subject: 'subject',
    owner: 'owner',
    attention: 'attention',
    detected: 'detectedAt',
    lastActivity: 'lastActivityAt',
  },
  decisions: {
    title: 'title',
    kind: 'kind',
    domain: 'domain',
    reason: 'reason',
    owner: 'owner',
    requested: 'requestedAt',
    deadline: 'deadline',
    impact: 'impact',
  },
  returns: {
    name: 'name',
    kind: 'kind',
    stage: 'stage',
    items: 'quantity',
    refund: 'refund',
    value: 'value',
    reasons: 'reasons',
    requested: 'requestedAt',
    activity: 'activityAt',
    source: 'connectionId',
  },
};

/** Item keys a view reader may group, aggregate or show: `id` and its catalog columns. */
export function viewReaderKeys(domain: ViewReaderDomain): readonly string[] {
  return ['id', ...Object.values(viewReaderColumns[domain])];
}

/** Lists the view engine can read, in the order drafts describe them. */
export const viewReaderDomains: readonly ViewReaderDomain[] = [
  'orders',
  'inventory',
  'fulfillment',
  'customers',
  'products',
  'procurement',
  'issues',
  'decisions',
  'returns',
];

/** Whether the view engine has a reader for a list. */
export function isViewReaderDomain(
  domain: AdaptiveViewDomain,
): domain is ViewReaderDomain {
  return viewReaderDomains.some((item) => item === domain);
}

function defaultViewQuery(
  domain: ViewReaderDomain,
  segment: string,
  columns: string[],
  conditions: ViewCondition[] = [],
): AdaptiveViewQuery {
  return {
    version: 2,
    domain,
    state: {
      segment,
      where: { match: 'all', conditions },
      sort: null,
      group: null,
      layout: 'table',
      density: 'comfortable',
      columns: columns.map((id) => ({ id })),
      properties: [],
      preview: false,
    },
    metrics: [],
    charts: [],
    actions: [],
  };
}

export const builtInViews = [
  {
    id: 'stuck-orders',
    name: { en: 'Stuck orders', de: 'Festhängende Bestellungen' },
    query: defaultViewQuery('orders', 'stuck', [
      'number',
      'status',
      'fulfillment',
      'due',
    ]),
  },
  {
    id: 'inventory-discrepancies',
    name: { en: 'Inventory discrepancies', de: 'Bestandsabweichungen' },
    query: defaultViewQuery('inventory', 'differs', [
      'sku',
      'location',
      'differences',
      'sources',
    ]),
  },
  {
    id: 'supplier-decisions',
    name: { en: 'Supplier decisions', de: 'Lieferantenentscheidungen' },
    query: defaultViewQuery(
      'decisions',
      'all',
      ['kind', 'reason', 'title'],
      [{ field: 'domain', op: 'any_of', value: ['procurement'] }],
    ),
  },
] as const;
