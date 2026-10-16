import type {
  SyncConnectionView,
  SyncOverview,
  SyncRecordView,
  SyncRunView,
  SyncStreamView,
} from '@luma/api-contract';

export const organizationId = '33333333-3333-4333-8333-333333333333';

const asOf = '2026-09-29T09:00:00.000Z';

let next = 0;

/** Builds a sync stream fixture; unspecified fields describe an up-to-date sync. */
export function stream(patch: Partial<SyncStreamView> = {}): SyncStreamView {
  next += 1;

  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`,
    status: 'up_to_date',
    phase: 'incremental',
    paused: false,
    blocked: null,
    scan: null,
    records: {
      total: 0,
      current: 0,
      pending: 0,
      failed: 0,
      retired: 0,
      missing: 0,
    },
    problems: [],
    coverage: {
      oldest: null,
      newest: null,
      historyFrom: null,
      historyRequirement: null,
      olderHistoryAvailable: false,
    },
    lastSuccessAt: '2026-09-29T08:57:30.000Z',
    lastCompleteAt: '2026-09-29T08:57:30.000Z',
    lastFullScanAt: '2026-09-29T02:10:00.000Z',
    backfillStartedAt: '2026-09-28T09:00:00.000Z',
    backfillCompletedAt: '2026-09-28T09:40:00.000Z',
    nextRunAt: '2026-09-29T09:03:00.000Z',
    error: null,
    ...patch,
  };
}

const counted = (
  total: number,
  patch: Partial<SyncStreamView['records']> = {},
) => ({
  total,
  current: total - (patch.pending ?? 0) - (patch.failed ?? 0),
  pending: 0,
  failed: 0,
  missing: 0,
  retired: 0,
  ...patch,
});

export const shopify: SyncConnectionView = {
  connectionId: '66666666-6666-4666-8666-666666666666',
  label: 'Shopify · Japan',
  provider: 'shopify',
  appId: 'shopify',
  status: 'active',
  recordTypes: [
    {
      recordType: 'orders',
      availability: 'granted',
      stream: stream({
        status: 'importing',
        phase: 'backfill',
        scan: {
          kind: 'backfill',
          startedAt: '2026-09-29T08:40:00.000Z',
          since: null,
          pages: 50,
          records: 1240,
          total: 3100,
        },
        records: counted(1240),
        backfillCompletedAt: null,
        lastFullScanAt: null,
        nextRunAt: asOf,
      }),
    },
    {
      recordType: 'fulfillments',
      availability: 'granted',
      stream: stream({
        status: 'waiting',
        phase: 'backfill',
        backfillCompletedAt: null,
        lastSuccessAt: null,
        lastFullScanAt: null,
        nextRunAt: asOf,
      }),
    },
    {
      recordType: 'products',
      availability: 'granted',
      stream: stream({ records: counted(412) }),
    },
    {
      recordType: 'inventory',
      availability: 'granted',
      stream: stream({
        status: 'syncing',
        scan: {
          kind: 'incremental',
          startedAt: '2026-09-29T08:59:40.000Z',
          since: null,
          pages: 3,
          records: 75,
          total: null,
        },
        records: counted(1650),
      }),
    },
    { recordType: 'customers', availability: 'not_requested', stream: null },
  ],
};

export const jtl: SyncConnectionView = {
  connectionId: '55555555-5555-4555-8555-555555555555',
  label: 'JTL-Wawi',
  provider: 'jtl',
  appId: 'jtl',
  status: 'active',
  recordTypes: [
    {
      recordType: 'orders',
      availability: 'granted',
      stream: stream({
        records: counted(18342, { missing: 2 }),
        coverage: {
          oldest: '2019-03-02T10:00:00.000Z',
          newest: '2026-09-29T08:40:00.000Z',
          historyFrom: null,
          historyRequirement: null,
          olderHistoryAvailable: false,
        },
      }),
    },
    {
      recordType: 'fulfillments',
      availability: 'granted',
      stream: stream({
        records: counted(17990, { pending: 3 }),
        problems: ['Waiting for its order to be imported'],
      }),
    },
    {
      recordType: 'products',
      availability: 'granted',
      stream: stream({ records: counted(905) }),
    },
    {
      recordType: 'inventory',
      availability: 'granted',
      stream: stream({
        status: 'retrying',
        records: counted(2210),
        error: {
          code: 'timeout',
          message:
            'The source did not respond in time. Luma retries automatically.',
          at: '2026-09-29T08:58:10.000Z',
          attempts: 2,
        },
        nextRunAt: '2026-09-29T09:00:40.000Z',
      }),
    },
    { recordType: 'customers', availability: 'not_requested', stream: null },
  ],
};

/** A workspace importing Shopify history while JTL stays current. */
export const importing: SyncOverview = {
  connections: [shopify, jtl],
  runs: [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      connectionId: shopify.connectionId,
      recordType: 'orders',
      kind: 'backfill',
      trigger: 'connection',
      since: null,
      fullScan: true,
      startedAt: '2026-09-29T08:40:00.000Z',
      finishedAt: null,
      outcome: 'running',
      pages: 50,
      records: 1240,
      changed: 1240,
      unchanged: 0,
      pending: 0,
      failed: 0,
      missing: null,
      errors: 1,
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      connectionId: jtl.connectionId,
      recordType: 'orders',
      kind: 'reconcile',
      trigger: 'schedule',
      since: null,
      fullScan: true,
      startedAt: '2026-09-29T02:10:00.000Z',
      finishedAt: '2026-09-29T02:31:00.000Z',
      outcome: 'completed',
      pages: 734,
      records: 18342,
      changed: 12,
      unchanged: 18330,
      pending: 0,
      failed: 0,
      missing: 2,
      errors: 0,
    },
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      connectionId: shopify.connectionId,
      recordType: 'products',
      kind: 'incremental',
      trigger: 'webhook',
      since: '2026-09-29T08:40:00.000Z',
      fullScan: false,
      startedAt: '2026-09-29T08:57:20.000Z',
      finishedAt: '2026-09-29T08:57:30.000Z',
      outcome: 'completed',
      pages: 1,
      records: 1,
      changed: 1,
      unchanged: 0,
      pending: 0,
      failed: 0,
      missing: 0,
      errors: 0,
    },
  ],
  canManage: true,
  asOf,
};

/** Everything imported; Shopify only shared its last 60 days of orders. */
export const current: SyncOverview = {
  ...importing,
  connections: [
    {
      ...shopify,
      recordTypes: [
        {
          recordType: 'orders',
          availability: 'granted',
          stream: stream({
            records: counted(3100),
            coverage: {
              oldest: '2026-07-31T11:20:00.000Z',
              newest: '2026-09-29T08:52:00.000Z',
              historyFrom: '2026-07-31T09:00:00.000Z',
              historyRequirement: 'read_all_orders',
              olderHistoryAvailable: false,
            },
          }),
        },
        {
          recordType: 'fulfillments',
          availability: 'granted',
          stream: stream({ records: counted(2870) }),
        },
        {
          recordType: 'products',
          availability: 'granted',
          stream: stream({ records: counted(412) }),
        },
        {
          recordType: 'inventory',
          availability: 'granted',
          stream: stream({ records: counted(1650) }),
        },
        {
          recordType: 'customers',
          availability: 'granted',
          stream: stream({
            records: counted(2204),
            coverage: {
              oldest: '2021-05-11T10:00:00.000Z',
              newest: '2026-09-28T19:00:00.000Z',
              historyFrom: null,
              historyRequirement: null,
              olderHistoryAvailable: false,
            },
          }),
        },
      ],
    },
  ],
  runs: importing.runs.slice(1),
};

/** Syncs that need a person: a failing read and a sync whose owner left. */
export const attention: SyncOverview = {
  ...importing,
  connections: [
    {
      ...jtl,
      recordTypes: jtl.recordTypes.map((item) =>
        item.recordType === 'inventory' && item.stream
          ? {
              ...item,
              stream: {
                ...item.stream,
                status: 'failing',
                error: { ...item.stream.error!, attempts: 6 },
              },
            }
          : item.recordType === 'orders' && item.stream
            ? {
                ...item,
                stream: {
                  ...item.stream,
                  status: 'blocked',
                  blocked: 'principal_unavailable',
                  nextRunAt: null,
                },
              }
            : item,
      ),
    },
  ],
};

/** Recent records available while Shopify prepares its older-history export. */
export const recentHistory: SyncOverview = {
  ...current,
  connections: current.connections.map((connection) => ({
    ...connection,
    recordTypes: connection.recordTypes.map((item) =>
      item.recordType === 'orders' && item.stream
        ? {
            ...item,
            stream: {
              ...item.stream,
              status: 'importing',
              phase: 'backfill',
              backfillCompletedAt: null,
              coverage: {
                ...item.stream.coverage,
                recentFrom: '2026-08-30T09:00:00.000Z',
                recentCompletedAt: '2026-09-29T08:59:00.000Z',
              },
              scan: {
                kind: 'backfill',
                startedAt: '2026-09-29T08:59:00.000Z',
                since: null,
                createdSince: null,
                waitingForExport: true,
                pages: 0,
                records: 0,
                total: null,
              },
            },
          }
        : item,
    ),
  })),
};

/** Imports waiting for shared capacity while another connection reads recent changes. */
export const waiting: SyncOverview = {
  ...importing,
  connections: importing.connections.map((connection, index) => ({
    ...connection,
    recordTypes: connection.recordTypes.map((item) => {
      if (!item.stream) return item;
      if (index === 1 && item.recordType === 'orders')
        return {
          ...item,
          stream: {
            ...item.stream,
            status: 'syncing',
            scan: {
              kind: 'incremental',
              startedAt: asOf,
              since: '2026-09-29T08:50:00.000Z',
              pages: 2,
              records: 80,
              total: null,
            },
          },
        };
      if (
        index !== 0 ||
        !['orders', 'fulfillments', 'products'].includes(item.recordType)
      )
        return item;

      return {
        ...item,
        stream: {
          ...item.stream,
          status: 'waiting',
          waiting: {
            reason:
              item.recordType === 'orders'
                ? 'worker_capacity'
                : item.recordType === 'fulfillments'
                  ? 'orders'
                  : 'request_capacity',
            connections:
              item.recordType === 'orders'
                ? [
                    {
                      connectionId: importing.connections[1]!.connectionId,
                      label: importing.connections[1]!.label,
                    },
                  ]
                : [],
            observedAt: asOf,
            until:
              item.recordType === 'fulfillments'
                ? null
                : '2026-09-29T09:01:00.000Z',
          },
        },
      };
    }),
  })),
};

/** Request-budget waits, a provider cooldown and a rate-limited page retry. */
export const rateLimited: SyncOverview = {
  ...waiting,
  connections: waiting.connections.map((connection, index) => ({
    ...connection,
    recordTypes: connection.recordTypes.map((item) => {
      if (!item.stream || item.recordType !== 'orders') return item;

      return {
        ...item,
        stream: {
          ...item.stream,
          status: index === 0 ? 'waiting' : 'retrying',
          waiting:
            index === 0
              ? {
                  reason: 'provider_cooldown',
                  connections: [],
                  observedAt: asOf,
                  until: '2026-09-29T09:01:00.000Z',
                }
              : null,
          nextRunAt: '2026-09-29T09:01:00.000Z',
          error:
            index === 0
              ? null
              : {
                  code: 'rate_limited',
                  message: 'The source asked Luma to slow down.',
                  at: asOf,
                  attempts: 1,
                },
        },
      };
    }),
  })),
};

/** The latest runs of Shopify's orders sync while its history imports. */
export const orderRuns: SyncRunView[] = [
  importing.runs[0]!,
  {
    ...importing.runs[0]!,
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    kind: 'incremental',
    trigger: 'webhook',
    since: '2026-09-29T08:30:00.000Z',
    fullScan: false,
    startedAt: '2026-09-29T08:35:00.000Z',
    finishedAt: '2026-09-29T08:35:04.000Z',
    outcome: 'completed',
    pages: 1,
    records: 3,
    changed: 2,
    unchanged: 1,
    errors: 0,
  },
  {
    ...importing.runs[0]!,
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    createdSince: '2026-08-30T08:00:00.000Z',
    startedAt: '2026-09-29T08:00:00.000Z',
    finishedAt: '2026-09-29T08:31:00.000Z',
    outcome: 'completed',
    pages: 40,
    records: 980,
    changed: 980,
    errors: 0,
  },
];

/** Older Shopify history became available, and some JTL products couldn't import. */
export const opportunities: SyncOverview = {
  ...current,
  connections: [
    {
      ...current.connections[0]!,
      recordTypes: current.connections[0]!.recordTypes.map((item) =>
        item.recordType === 'orders' && item.stream
          ? {
              ...item,
              stream: {
                ...item.stream,
                coverage: {
                  ...item.stream.coverage,
                  olderHistoryAvailable: true,
                },
              },
            }
          : item,
      ),
    },
    {
      ...jtl,
      recordTypes: jtl.recordTypes.map((item) =>
        item.recordType === 'products' && item.stream
          ? {
              ...item,
              stream: {
                ...item.stream,
                records: counted(905, { failed: 2 }),
                problems: ['The product has no SKU code'],
              },
            }
          : item.recordType === 'inventory' && item.stream
            ? {
                ...item,
                stream: { ...item.stream, status: 'up_to_date', error: null },
              }
            : item,
      ),
    },
  ],
};

/** The two JTL products that couldn't import; one was imported before its SKU code was removed. */
export const productProblems: SyncRecordView[] = [
  {
    externalId: '10442',
    resource: 'product',
    state: 'failed',
    problem: 'The product has no SKU code',
    entityId: null,
    sourceCreatedAt: '2026-09-20T09:00:00.000Z',
    lastSeenAt: '2026-09-29T08:55:00.000Z',
    missingSince: null,
  },
  {
    externalId: '10518',
    resource: 'product',
    state: 'failed',
    problem: 'The product has no SKU code',
    entityId: '99999999-9999-4999-8999-999999999999',
    sourceCreatedAt: '2026-04-02T09:00:00.000Z',
    lastSeenAt: '2026-09-29T08:55:00.000Z',
    missingSince: null,
  },
];

/** A JTL connection that was disconnected, so its syncs stop. */
export const disconnected: SyncOverview = {
  ...current,
  connections: [
    ...current.connections,
    {
      ...jtl,
      status: 'disconnected',
      recordTypes: jtl.recordTypes.map((item) =>
        item.stream
          ? {
              ...item,
              stream: {
                ...item.stream,
                status: 'blocked',
                blocked: 'connection_inactive',
                error: null,
                nextRunAt: null,
              },
            }
          : item,
      ),
    },
  ],
};
