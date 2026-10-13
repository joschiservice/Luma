export type AdaptiveViewDomain =
  | 'orders'
  | 'inventory'
  | 'fulfillment'
  | 'customers'
  | 'products'
  | 'procurement'
  | 'issues'
  | 'decisions';

type ViewScalar = string | number | boolean | null;

export interface AdaptiveViewQuery {
  version: 1;
  domain: AdaptiveViewDomain;
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
  metrics: {
    id: string;
    operation: 'count' | 'sum' | 'average';
    field: string | null;
  }[];
  charts: {
    id: string;
    type: 'bar' | 'line';
    groupBy: string;
    metricId: string;
  }[];
  actions: {
    id: string;
    label: { en: string; de: string };
    target: {
      kind: 'capability' | 'workflow';
      id: string;
      version?: string | undefined;
    };
    inputs: Record<
      string,
      | { source: 'row'; field: string }
      | { source: 'literal'; value: ViewScalar }
    >;
  }[];
}

export interface AdaptiveViewInput {
  commandId: string;
  name: string;
  description: string;
  sharing: { scope: 'private' | 'workspace' | 'roles'; roleIds: string[] };
  query: AdaptiveViewQuery;
  reviewed: true;
}

export interface StoredAdaptiveView extends Omit<
  AdaptiveViewInput,
  'reviewed' | 'commandId'
> {
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

export const viewPermissions: Record<AdaptiveViewDomain, string> = {
  orders: 'orders.read',
  inventory: 'inventory.read',
  fulfillment: 'fulfillment.read',
  customers: 'customers.read',
  products: 'products.read',
  procurement: 'procurement.read',
  issues: 'issues.read',
  decisions: 'issues.read',
};

export const viewColumns: Record<AdaptiveViewDomain, readonly string[]> = {
  orders: [
    'id',
    'displayNumber',
    'status',
    'paymentStatus',
    'fulfillment',
    'placedAt',
    'dueAt',
    'total',
    'lineCount',
    'overdue',
    'differs',
    'observedAt',
  ],
  inventory: [
    'id',
    'skuId',
    'sku',
    'locationId',
    'location',
    'unit',
    'sources',
    'differences',
    'sync',
  ],
  fulfillment: [
    'id',
    'connectionId',
    'externalId',
    'kind',
    'status',
    'open',
    'signals',
    'holds',
    'location',
    'method',
    'fulfillAt',
    'fulfillBy',
    'estimatedDeliveryAt',
    'progressAt',
    'order',
    'units',
    'unit',
    'observedAt',
  ],
  customers: [
    'id',
    'connectionId',
    'externalId',
    'displayName',
    'email',
    'phone',
    'state',
    'sourceCreatedAt',
    'orderCount',
    'amountSpent',
    'tags',
    'sourceUpdatedAt',
    'observedAt',
  ],
  products: [
    'id',
    'skuId',
    'sku',
    'skuKey',
    'title',
    'listings',
    'differences',
    'gaps',
  ],
  procurement: [
    'id',
    'supplierId',
    'supplierName',
    'reference',
    'number',
    'status',
    'attentionKey',
    'confirmationDueAt',
    'nextCheckAt',
    'connectionId',
    'lines',
    'createdAt',
    'updatedAt',
  ],
  issues: [
    'id',
    'class',
    'state',
    'severity',
    'summary',
    'subject',
    'detectedAt',
    'lastActivityAt',
    'owner',
    'attention',
  ],
  decisions: [
    'id',
    'kind',
    'domain',
    'reason',
    'title',
    'why',
    'response',
    'owner',
    'assignment',
    'requestedAt',
    'deadline',
    'evidence',
    'impact',
  ],
};

function defaultViewQuery(
  input: Pick<AdaptiveViewQuery, 'version' | 'domain' | 'filters' | 'columns'>,
): AdaptiveViewQuery {
  return {
    ...input,
    customFilters: [],
    sort: null,
    groupBy: null,
    layout: 'table',
    metrics: [],
    charts: [],
    actions: [],
  };
}

export const builtInViews = [
  {
    id: 'stuck-orders',
    name: { en: 'Stuck orders', de: 'Festhängende Bestellungen' },
    query: defaultViewQuery({
      version: 1,
      domain: 'orders',
      filters: { view: 'stuck' },
      columns: ['displayNumber', 'status', 'fulfillment', 'dueAt'],
    }),
  },
  {
    id: 'inventory-discrepancies',
    name: { en: 'Inventory discrepancies', de: 'Bestandsabweichungen' },
    query: defaultViewQuery({
      version: 1,
      domain: 'inventory',
      filters: { view: 'differs' },
      columns: ['sku', 'location', 'differences', 'sources'],
    }),
  },
  {
    id: 'supplier-decisions',
    name: { en: 'Supplier decisions', de: 'Lieferantenentscheidungen' },
    query: defaultViewQuery({
      version: 1,
      domain: 'decisions',
      filters: { domain: 'procurement' },
      columns: ['kind', 'reason', 'title', 'response'],
    }),
  },
] as const;
