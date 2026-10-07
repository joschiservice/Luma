import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { createCommerceServices } from '@luma/application-runtime';
import { createSyncRunner, createSyncService } from '@luma/commerce-sync';
import {
  createIdentityReader,
  createSyncStore,
} from '@luma/commerce-sync/composition';
import type {
  CapabilityReader,
  CapabilityResult,
  CommerceObservation,
  Observation,
  ReadCapability,
} from '@luma/connections';
import { createReadChecks } from '@luma/connections/composition';
import { createCustomerProfiles } from '@luma/customers/composition';
import {
  orderAttentionForOrders,
  orderAttentionQuery,
} from '@luma/exceptions/composition';
import type { TenantContext } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import {
  createOrderMetricReader,
  orderStateQueries,
} from '@luma/orders/composition';
import type { TenantDatabase } from '@luma/platform';
import { createTenantDatabase } from '@luma/platform/composition';
import {
  createOrderWorkspace,
  createRecordExplorer,
} from '@luma/read-models/composition';
import { createActivityStore } from '@luma/resolution/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

const reads = [
  'orders.read',
  'fulfillment.read',
  'products.read',
  'inventory.read',
  'customers.read',
] as const;

type Item = Omit<Observation<unknown>, 'id' | 'observedAt'>;

/** An in-memory source that pages like an installed adapter and can fail on demand. */
function provider(tenantId: string, erpId: string) {
  const collections = new Map<string, Item[]>();
  const failures: {
    connectionId: string;
    capability: string;
    cursor?: string;
  }[] = [];
  const requests: {
    connectionId: string;
    capability: string;
    cursor?: string;
    updatedSince?: string;
    createdSince?: string;
  }[] = [];
  let historyLimited = true;
  let recentEnabled = false;
  let onRead:
    ((request: (typeof requests)[number]) => Promise<void>) | undefined;
  const reader: CapabilityReader = {
    async discover(_context, connectionId) {
      return collections.has(`${connectionId}:orders.read`) ||
        [...collections.keys()].some((key) => key.startsWith(connectionId))
        ? reads.map((capability) => ({
            capability,
            version: '0' as const,
            minimumRisk: 'low' as const,
            idempotency: 'none' as const,
            retry: { maxAttempts: 1, initialDelayMs: 1 },
            ...(capability === 'orders.read' || capability === 'customers.read'
              ? {
                  filters: [
                    'updatedSince' as const,
                    ...(recentEnabled && capability === 'orders.read'
                      ? ['createdSince' as const]
                      : []),
                  ],
                }
              : {}),
          }))
        : [];
    },
    async read(_context, request) {
      const input = request.input as {
        limit: number;
        cursor?: string;
        updatedSince?: string;
        createdSince?: string;
      };
      requests.push({
        connectionId: request.connectionId,
        capability: request.capability,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.updatedSince ? { updatedSince: input.updatedSince } : {}),
        ...(input.createdSince ? { createdSince: input.createdSince } : {}),
      });
      await onRead?.(requests.at(-1)!);
      const failure = failures.findIndex(
        (item) =>
          item.connectionId === request.connectionId &&
          item.capability === request.capability &&
          item.cursor === input.cursor,
      );
      if (failure >= 0) {
        failures.splice(failure, 1);

        return {
          ok: false,
          error: { code: 'transient', effect: 'none', retry: 'after_delay' },
        } as CapabilityResult<ReadCapability>;
      }
      const all = (
        collections.get(`${request.connectionId}:${request.capability}`) ?? []
      )
        .filter(
          (item) =>
            !input.updatedSince ||
            (item.sourceUpdatedAt ?? '') >= input.updatedSince,
        )
        .filter(
          (item) =>
            !input.createdSince ||
            (item.data as { placedAt: string }).placedAt >= input.createdSince,
        );
      const start = Number(input.cursor ?? 0);
      const observedAt = new Date().toISOString();
      const items = all.slice(start, start + input.limit).map((item) => ({
        ...structuredClone(item),
        id: randomUUID(),
        observedAt,
      }));
      const next = start + input.limit < all.length;

      return {
        ok: true,
        value: {
          items,
          nextCursor: next ? String(start + input.limit) : null,
          completeness: 'complete',
          ...(start === 0 ? { total: all.length } : {}),
          ...(start === 0 && request.capability === 'orders.read'
            ? {
                history: historyLimited
                  ? {
                      availableFrom: '2026-07-31T00:00:00.000Z',
                      requirement: 'read_all_orders',
                    }
                  : null,
              }
            : {}),
        },
      } as CapabilityResult<ReadCapability>;
    },
  };

  return {
    reader,
    requests,
    set(connectionId: string, capability: ReadCapability, items: Item[]) {
      collections.set(`${connectionId}:${capability}`, items);
    },
    fail(connectionId: string, capability: string, cursor?: string) {
      failures.push({
        connectionId,
        capability,
        ...(cursor ? { cursor } : {}),
      });
    },
    recentHistory() {
      recentEnabled = true;
    },
    onRead(next: typeof onRead) {
      onRead = next;
    },
    grantAllOrders() {
      historyLimited = false;
    },
    source(
      connectionId: string,
      resource: Item['source']['resource'],
      externalId: string,
      scopeKey = '',
    ) {
      return {
        tenantId,
        connectionId,
        provider: connectionId === erpId ? 'jtl' : 'shopify',
        resource,
        externalId,
        scopeKey,
      };
    },
  };
}

describe.skipIf(!databaseUrl)('commerce sync on PostgreSQL', () => {
  const name = `sync_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const tenant = randomUUID();
  const shop = randomUUID();
  const erp = randomUUID();
  let owner: Pool;
  let runtime: Pool;
  let db: TenantDatabase;
  let services: ReturnType<typeof createCommerceServices>;
  let source: ReturnType<typeof provider>;
  let runner: ReturnType<typeof createSyncRunner>;
  let service: ReturnType<typeof createSyncService>;
  const members = new Map<string, 'owner' | 'admin' | 'member'>([
    ['operator', 'owner'],
    ['viewer', 'member'],
  ]);

  function context(user = 'operator'): TenantContext {
    const role = members.get(user);
    if (!role) throw new Error('Membership not found');

    return makeTenantContext(
      { userId: user, sessionId: 'session' },
      {
        id: tenant,
        name: 'Fixture',
        slug: 'fixture',
        status: 'active',
        dataRegion: 'EU',
      },
      builtInMembership(
        { id: `m-${user}`, organizationId: tenant, userId: user },
        role,
      ),
      randomUUID(),
    );
  }

  const order = (
    connectionId: string,
    id: string,
    options: {
      updated?: string;
      placed?: string;
      status?: 'open' | 'completed';
      sku?: string;
      number?: string;
      externalNumber?: string;
      extraLine?: boolean;
    } = {},
  ): Item => ({
    source: source.source(connectionId, 'order', id),
    kind: 'snapshot',
    sourceUpdatedAt: options.updated ?? '2026-09-01T10:00:00.000Z',
    sourceRevision: null,
    adapterVersion: 'fixture/1',
    schemaVersion: 1,
    data: {
      displayNumber: options.number ?? `#${id}`,
      ...(options.externalNumber === undefined
        ? {}
        : { externalOrderNumber: options.externalNumber }),
      placedAt: options.placed ?? '2026-08-15T10:00:00.000Z',
      total: { amount: '10.00', currency: 'EUR' },
      status: options.status ?? 'open',
      paymentStatus: 'paid',
      lines: [
        {
          id: { externalId: `${id}-line`, scopeKey: id },
          sku: { externalId: options.sku ?? 'item-1', scopeKey: '' },
          quantity: { amount: '1', unit: 'each' },
          cancelledQuantity: null,
          skuCode: 'ABC-1',
          title: 'Mug',
        },
        ...(options.extraLine
          ? [
              {
                id: { externalId: `${id}-added`, scopeKey: id },
                sku: null,
                quantity: { amount: '1', unit: 'each' },
                cancelledQuantity: null,
                title: 'Shipping fee',
              },
            ]
          : []),
      ],
    },
  });

  const shipment = (
    connectionId: string,
    id: string,
    orderId: string,
  ): Item => ({
    source: source.source(connectionId, 'fulfillment', id),
    kind: 'snapshot',
    sourceUpdatedAt: '2026-09-02T10:00:00.000Z',
    sourceRevision: null,
    adapterVersion: 'fixture/1',
    schemaVersion: 1,
    data: {
      order: { externalId: orderId, scopeKey: '' },
      status: 'shipped',
      lines: [
        {
          orderLine: { externalId: `${orderId}-line`, scopeKey: orderId },
          quantity: { amount: '1', unit: 'each' },
        },
      ],
      lastProgressAt: '2026-09-02T10:00:00.000Z',
      failureCode: null,
    },
  });

  const product = (
    connectionId: string,
    id: string,
    sku: string,
    code: string,
  ): Item => ({
    source: source.source(connectionId, 'product', id),
    kind: 'snapshot',
    sourceUpdatedAt: '2026-09-01T10:00:00.000Z',
    sourceRevision: null,
    adapterVersion: 'fixture/1',
    schemaVersion: 1,
    data: {
      title: 'Mug',
      status: 'active',
      skus: [{ id: { externalId: sku, scopeKey: '' }, code, unit: 'each' }],
    },
  });

  const stock = (
    connectionId: string,
    sku: string,
    available: string,
  ): Item => ({
    source: source.source(connectionId, 'sku', sku, 'store'),
    kind: 'snapshot',
    sourceUpdatedAt: '2026-09-01T10:00:00.000Z',
    sourceRevision: null,
    adapterVersion: 'fixture/1',
    schemaVersion: 1,
    data: {
      sku: { externalId: sku, scopeKey: '' },
      location: { externalId: 'store', scopeKey: '' },
      unit: 'each',
      onHand: available,
      reserved: '0',
      available,
      availabilityBasis: 'provider_reported',
    },
  });

  const customer = (connectionId: string, id: string): Item => ({
    source: source.source(connectionId, 'customer', id),
    kind: 'snapshot',
    sourceUpdatedAt: '2026-09-01T10:00:00.000Z',
    sourceRevision: null,
    adapterVersion: 'fixture/1',
    schemaVersion: 1,
    data: {
      displayName: 'Ada Lovelace',
      email: 'ada@example.test',
      phone: null,
      address: null,
      state: 'enabled',
      createdAt: '2025-01-02T10:00:00.000Z',
      orderCount: 3,
      amountSpent: { amount: '42.50', currency: 'EUR' },
      tags: ['vip'],
      shared: { contact: true, address: false },
    },
  });

  async function stream(recordType: string, connectionId = shop) {
    return (
      await owner.query<{
        id: string;
        phase: string;
        scan: string | null;
        cursor: string | null;
        attempts: number;
        error_code: string | null;
        blocked: string | null;
        history_from: Date | null;
        watermark: Date | null;
        principal_id: string;
      }>(
        'SELECT * FROM commerce_sync_streams WHERE tenant_id=$1 AND connection_id=$2 AND record_type=$3',
        [tenant, connectionId, recordType],
      )
    ).rows[0];
  }

  async function due() {
    await owner.query(
      'UPDATE commerce_sync_streams SET due_at=now() WHERE tenant_id=$1',
      [tenant],
    );
  }

  /** Runs passes until no stream is due or the limit is reached. */
  async function drain(limit = 30) {
    for (let pass = 0; pass < limit; pass++) {
      const scopes = await runner.scopes();
      if (!scopes.includes(tenant)) return;
      await runner.tick(tenant, 5000);
    }
  }

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    owner = new Pool({ connectionString: url.toString() });
    const setup = await admin.connect();
    try {
      await setup.query(
        "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
      );
      for (const file of (
        await readdir(new URL('../migrations/', import.meta.url))
      ).sort())
        if (file.endsWith('.sql'))
          await owner.query(
            await readFile(
              new URL(`../migrations/${file}`, import.meta.url),
              'utf8',
            ),
          );
    } finally {
      await setup.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
      setup.release();
    }
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(
      `GRANT luma_connectors,luma_orders,luma_inventory,luma_case_reader,luma_desk,luma_commerce_sync,luma_customers TO "${name}"`,
    );
    url.username = name;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString() });
    db = createTenantDatabase(runtime);
    services = createCommerceServices(db);
  });

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.end();
  });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE commerce_sync_runs,commerce_sync_items,commerce_sync_streams,commerce_identity_links,
        customer_profiles,customer_erasures,connector_refresh_hints,connector_read_checks,
        connector_mapping_revisions,connector_observations,connector_source_mappings,
        connector_lifecycle_events,connector_installations,orders_entities,inventory_entities CASCADE`,
    );
    for (const [id, label] of [
      [shop, 'Main store'],
      [erp, 'Warehouse ERP'],
    ] as const) {
      await owner.query(
        'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
        [
          tenant,
          id,
          {
            id,
            tenantId: tenant,
            version: 1,
            status: 'active',
            provider: id === erp ? 'jtl' : 'shopify',
            target: { kind: id === erp ? 'jtl' : 'shopify' },
            label,
            permissions: reads,
            granted: reads,
          },
          'encrypted-fixture',
        ],
      );
      await owner.query(
        `INSERT INTO connector_lifecycle_events(tenant_id,connection_id,version,event,actor_id,status,credential_version)
        VALUES($1,$2,1,'installed','operator','active',1)`,
        [tenant, id],
      );
    }
    source = provider(tenant, erp);
    for (const connectionId of [shop, erp])
      for (const capability of reads) source.set(connectionId, capability, []);
    runner = createSyncRunner({
      store: createSyncStore(db),
      reader: source.reader,
      ingestion: services.ingestion,
      customers: createCustomerProfiles(db),
      recordRead: createReadChecks(db),
      resolveContext: async (principal) => context(principal),
      digest: (value) => createHash('sha256').update(value).digest('hex'),
      pageSize: 2,
    });
    service = createSyncService({
      store: createSyncStore(db),
      connections: {
        list: async () =>
          (
            await owner.query<{ document: never }>(
              'SELECT document FROM connector_installations WHERE tenant_id=$1 ORDER BY id',
              [tenant],
            )
          ).rows.map((row) => row.document),
      },
      identities: createIdentityReader(db),
      refreshContext: async (value) => value,
    });
  });

  it('admits independent connections concurrently and enforces connection leases across runners', async () => {
    const store = createSyncStore(db);
    for (const connectionId of [shop, erp])
      await store.createStreams(
        tenant,
        connectionId,
        ['orders', 'products'],
        'operator',
      );
    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        store.claim(tenant, randomUUID(), 60_000),
      ),
    );
    const active = claims.filter((claim) => claim !== null);
    expect(active).toHaveLength(2);
    expect(new Set(active.map((claim) => claim.connectionId)).size).toBe(2);
    expect(await store.claim(tenant, randomUUID(), 60_000)).toBeNull();
    expect(
      await store.claim(tenant, randomUUID(), 60_000, {
        connectionConcurrency: 2,
        workspaceConcurrency: 2,
      }),
    ).toBeNull();
    expect(await store.claim(randomUUID(), randomUUID(), 60_000)).toBeNull();
    await store.deferConnection(
      tenant,
      shop,
      new Date(Date.now() + 60_000).toISOString(),
    );
    await owner.query(
      'UPDATE commerce_sync_streams SET lease_until=NULL WHERE tenant_id=$1 AND connection_id=$2',
      [tenant, shop],
    );
    expect(
      await store.claim(tenant, randomUUID(), 60_000, { connectionId: shop }),
    ).toBeNull();
  });

  it('persists recent coverage and restores an export checkpoint after a live read and restart', async () => {
    const store = createSyncStore(db);
    const tokens = {
      recent: randomUUID(),
      child: randomUUID(),
      live: randomUUID(),
      history: randomUUID(),
      preempt: randomUUID(),
      resume: randomUUID(),
    };
    await store.createStreams(
      tenant,
      shop,
      ['orders', 'fulfillments'],
      'operator',
    );
    const claimed = (await store.claim(tenant, tokens.recent, 60_000))!;
    expect(claimed.recordType).toBe('orders');
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const recentFrom = new Date(Date.now() - 30 * 86400_000).toISOString();
    const nextDueAt = new Date(Date.now() + 300_000).toISOString();
    const empty = {
      entries: [],
      unchanged: [],
      counts: { records: 0, changed: 0, unchanged: 0, pending: 0, failed: 0 },
      total: 0,
      history: null,
      now: new Date().toISOString(),
    };
    await store.startScan(tenant, claimed.id, tokens.recent, {
      id: randomUUID(),
      plan: {
        kind: 'backfill',
        since: null,
        createdSince: recentFrom,
        trigger: 'connection',
      },
      fullScan: false,
      now: startedAt,
      liveEnabled: true,
    });
    await store.commitPage(tenant, claimed.id, tokens.recent, {
      ...empty,
      nextCursor: null,
      complete: { nextDueAt },
    });
    let streams = await createSyncStore(db).streams(tenant);
    expect(streams.find((item) => item.id === claimed.id)).toMatchObject({
      phase: 'backfill',
      recentHistoryFrom: recentFrom,
      recentHistoryCompletedAt: empty.now,
      backfillCompletedAt: null,
    });
    const child = await store.claim(tenant, tokens.child, 60_000);
    expect(child?.recordType).toBe('fulfillments');
    await store.command(tenant, child!.id, { kind: 'pause' }, 'operator');
    await owner.query(
      "UPDATE commerce_sync_streams SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",
      [tenant, child!.id],
    );

    // A hint between phases must not turn partial history into completed history.
    const live = (await store.claim(tenant, tokens.live, 60_000))!;
    await store.startScan(tenant, live.id, tokens.live, {
      id: randomUUID(),
      plan: { kind: 'incremental', since: startedAt, trigger: 'webhook' },
      fullScan: false,
      now: empty.now,
      liveEnabled: true,
    });
    await store.commitPage(tenant, live.id, tokens.live, {
      ...empty,
      nextCursor: null,
      complete: { nextDueAt },
    });
    expect(
      (await store.streams(tenant)).find((item) => item.id === live.id)?.phase,
    ).toBe('backfill');

    const history = (await store.claim(tenant, tokens.history, 60_000))!;
    const historyId = randomUUID();
    await store.startScan(tenant, history.id, tokens.history, {
      id: historyId,
      plan: { kind: 'backfill', since: null, trigger: 'connection' },
      fullScan: true,
      now: empty.now,
      liveEnabled: true,
    });
    await store.commitPage(tenant, history.id, tokens.history, {
      ...empty,
      nextCursor: 'export:chunk-2',
      complete: null,
      deferred: true,
    });
    const preempt = (await store.claim(tenant, tokens.preempt, 60_000))!;
    expect(preempt.scan).toMatchObject({
      cursor: 'export:chunk-2',
      waitingForExport: true,
    });
    await store.suspendScan(tenant, preempt.id, tokens.preempt);
    await store.startScan(tenant, preempt.id, tokens.preempt, {
      id: randomUUID(),
      plan: { kind: 'incremental', since: startedAt, trigger: 'webhook' },
      fullScan: false,
      now: empty.now,
      liveEnabled: true,
    });
    await store.commitPage(tenant, preempt.id, tokens.preempt, {
      ...empty,
      nextCursor: null,
      complete: { nextDueAt },
    });
    streams = await createSyncStore(db).streams(tenant);
    expect(streams.find((item) => item.id === history.id)).toMatchObject({
      phase: 'backfill',
      suspendedScan: null,
      scan: {
        id: historyId,
        cursor: 'export:chunk-2',
        waitingForExport: true,
        pages: 0,
      },
      backfillCompletedAt: null,
    });
    const resumed = (await store.claim(tenant, tokens.resume, 60_000))!;
    await store.commitPage(tenant, resumed.id, tokens.resume, {
      ...empty,
      nextCursor: null,
      complete: { nextDueAt },
    });
    expect(
      (await store.streams(tenant)).find((item) => item.id === resumed.id),
    ).toMatchObject({
      phase: 'incremental',
      scan: null,
      backfillCompletedAt: empty.now,
    });
  });

  it('runs a hinted live scan between history pages and resumes the history cursor', async () => {
    source.set(shop, 'orders.read', [
      order(shop, '1'),
      order(shop, '2'),
      order(shop, '3'),
    ]);
    let hinted = false;
    source.onRead(async (request) => {
      if (
        request.connectionId !== shop ||
        request.capability !== 'orders.read' ||
        hinted
      )
        return;
      hinted = true;
      source.set(shop, 'orders.read', [
        order(shop, '1'),
        order(shop, '2'),
        order(shop, '3'),
        order(shop, '4', {
          placed: new Date().toISOString(),
          updated: new Date().toISOString(),
        }),
      ]);
      await owner.query(
        "UPDATE commerce_sync_streams SET hint_at=now()-interval '1 second' WHERE tenant_id=$1 AND connection_id=$2 AND record_type='orders'",
        [tenant, shop],
      );
    });
    await drain();
    const requests = source.requests.filter(
      (request) =>
        request.connectionId === shop && request.capability === 'orders.read',
    );
    expect(
      requests.map((request) =>
        request.updatedSince ? 'live' : (request.cursor ?? 'start'),
      ),
    ).toEqual(['start', 'live', '2']);
    expect(await stream('orders')).toMatchObject({
      phase: 'incremental',
      scan: null,
    });
    expect(
      (await service.overview(context())).connections.find(
        (item) => item.connectionId === shop,
      )?.recordTypes[0]?.stream?.records,
    ).toMatchObject({ current: 4, missing: 0 });
  });

  it('reads the recent order window before older records without falsely finishing history', async () => {
    source.recentHistory();
    const recent = new Date(Date.now() - 86400_000).toISOString();
    source.set(shop, 'orders.read', [
      order(shop, 'old'),
      order(shop, 'recent', { placed: recent }),
    ]);
    await drain();
    const requests = source.requests.filter(
      (request) =>
        request.connectionId === shop && request.capability === 'orders.read',
    );
    expect(requests[0]?.createdSince).toBeDefined();
    expect(requests[1]?.createdSince).toBeUndefined();
    const completed = (await createSyncStore(db).streams(tenant)).find(
      (item) => item.recordType === 'orders' && item.connectionId === shop,
    )!;
    expect(completed.recentHistoryCompletedAt).not.toBeNull();
    expect(completed.backfillCompletedAt).not.toBeNull();
    expect(completed.phase).toBe('incremental');
  });

  it('imports history page by page, then reads only changes without duplicating records', async () => {
    source.set(shop, 'orders.read', [
      order(shop, '1', { placed: '2026-08-01T10:00:00.000Z' }),
      order(shop, '2'),
      order(shop, '3', { placed: '2026-09-20T10:00:00.000Z' }),
    ]);
    await drain();

    const orders = await stream('orders');
    expect(orders).toMatchObject({ phase: 'incremental', scan: null });
    expect(orders?.history_from?.toISOString()).toBe(
      '2026-07-31T00:00:00.000Z',
    );
    const overview = await service.overview(context('viewer'));
    const view = overview.connections
      .find((item) => item.connectionId === shop)
      ?.recordTypes.find((item) => item.recordType === 'orders');
    expect(view).toMatchObject({
      availability: 'granted',
      stream: {
        status: 'up_to_date',
        records: { total: 3, current: 3, pending: 0, failed: 0, missing: 0 },
        coverage: {
          oldest: '2026-08-01T10:00:00.000Z',
          newest: '2026-09-20T10:00:00.000Z',
          historyFrom: '2026-07-31T00:00:00.000Z',
          historyRequirement: 'read_all_orders',
          olderHistoryAvailable: false,
        },
      },
    });
    expect(overview.canManage).toBe(false);
    expect(
      source.requests
        .filter(
          (r) => r.connectionId === shop && r.capability === 'orders.read',
        )
        .map((r) => r.cursor ?? null),
    ).toEqual([null, '2']);

    // A re-import rereads everything but recognizes unchanged records.
    const count = async () =>
      Number(
        (
          await owner.query(
            "SELECT count(*) FROM orders_entities WHERE tenant_id=$1 AND kind='order'",
            [tenant],
          )
        ).rows[0].count,
      );
    expect(await count()).toBe(3);
    await service.command(context(), orders!.id, 'reimport');
    await drain();
    expect(await count()).toBe(3);
    const runs = await owner.query<{ kind: string; unchanged: number }>(
      "SELECT kind,unchanged FROM commerce_sync_runs r JOIN commerce_sync_streams s ON s.id=r.stream_id WHERE s.record_type='orders' ORDER BY r.started_at",
    );
    expect(runs.rows.at(-1)).toEqual({ kind: 'backfill', unchanged: 3 });

    // An older snapshot of a changed order is retained, never selected.
    const later = (seconds: number) =>
      new Date(Date.now() + seconds * 1000).toISOString();
    source.set(shop, 'orders.read', [
      order(shop, '1', { updated: later(60), status: 'completed' }),
    ]);
    await due();
    await drain();
    source.set(shop, 'orders.read', [
      order(shop, '1', { updated: later(30), status: 'open' }),
    ]);
    await due();
    await drain();
    const current = await owner.query<{ status: string }>(
      "SELECT s.status FROM orders_projections p JOIN orders_snapshots s ON s.id=p.snapshot_id WHERE p.tenant_id=$1 AND s.display_number='#1'",
      [tenant],
    );
    expect(current.rows).toEqual([{ status: 'completed' }]);
    expect(await count()).toBe(3);
    expect(
      source.requests.filter(
        (r) => r.capability === 'orders.read' && r.updatedSince,
      ).length,
    ).toBeGreaterThan(0);
  });

  it('resumes a failed page from its checkpoint', async () => {
    source.set(shop, 'orders.read', [
      order(shop, '1'),
      order(shop, '2'),
      order(shop, '3'),
    ]);
    source.fail(shop, 'orders.read', '2');
    await drain();
    expect(await stream('orders')).toMatchObject({
      phase: 'backfill',
      cursor: '2',
      attempts: 1,
      error_code: 'transient',
    });
    const failing = (await service.overview(context())).connections
      .find((item) => item.connectionId === shop)
      ?.recordTypes.find((item) => item.recordType === 'orders')?.stream;
    expect(failing).toMatchObject({
      status: 'retrying',
      error: { code: 'transient', attempts: 1 },
    });

    await due();
    await drain();
    expect(await stream('orders')).toMatchObject({
      phase: 'incremental',
      attempts: 0,
      error_code: null,
    });
    expect(
      source.requests
        .filter(
          (r) => r.connectionId === shop && r.capability === 'orders.read',
        )
        .map((r) => r.cursor ?? null),
    ).toEqual([null, '2', '2']);
  });

  it('imports fulfillments after their orders and flags records a full check no longer finds', async () => {
    source.set(shop, 'orders.read', [order(shop, '1'), order(shop, '2')]);
    source.set(shop, 'fulfillment.read', [shipment(shop, 'f1', '1')]);
    await drain();
    const fulfillments = await owner.query(
      "SELECT status FROM commerce_sync_items WHERE tenant_id=$1 AND record_type='fulfillments'",
      [tenant],
    );
    expect(fulfillments.rows).toEqual([{ status: 'current' }]);

    source.set(shop, 'orders.read', [order(shop, '1')]);
    await service.command(context(), (await stream('orders'))!.id, 'reconcile');
    await drain();
    const view = (await service.overview(context())).connections
      .find((item) => item.connectionId === shop)
      ?.recordTypes.find((item) => item.recordType === 'orders')?.stream;
    expect(view?.records).toMatchObject({ total: 2, missing: 1 });
    expect(
      Number(
        (
          await owner.query(
            "SELECT count(*) FROM orders_projections p JOIN orders_entities e ON e.id=p.entity_id WHERE e.tenant_id=$1 AND e.kind='order'",
            [tenant],
          )
        ).rows[0].count,
      ),
    ).toBe(2);
  });

  it('rotates a hinted scan, preserves retry backoff and consumes the hint after completion', async () => {
    const store = createSyncStore(db);
    await store.createStreams(tenant, shop, ['orders', 'products'], 'operator');
    await owner.query(
      "UPDATE commerce_sync_streams SET due_at=now()-interval '2 minutes' WHERE tenant_id=$1 AND record_type='orders'",
      [tenant],
    );
    const token = randomUUID();
    const first = await store.claim(tenant, token, 60_000, {
      connectionConcurrency: 2,
    });
    expect(first?.recordType).toBe('orders');
    await store.startScan(tenant, first!.id, token, {
      id: randomUUID(),
      plan: { kind: 'backfill', since: null, trigger: 'connection' },
      fullScan: true,
      now: new Date(Date.now() - 120_000).toISOString(),
    });
    await owner.query(
      "UPDATE commerce_sync_streams SET hint_at=now()-interval '1 minute' WHERE tenant_id=$1 AND id=$2",
      [tenant, first!.id],
    );
    const empty = {
      entries: [],
      unchanged: [],
      counts: { records: 0, changed: 0, unchanged: 0, pending: 0, failed: 0 },
      total: null,
      history: undefined,
      now: new Date().toISOString(),
    };
    await store.commitPage(tenant, first!.id, token, {
      ...empty,
      nextCursor: 'next',
      complete: null,
    });
    const other = await store.claim(tenant, randomUUID(), 60_000, {
      connectionConcurrency: 2,
    });
    expect(other?.recordType).toBe('products');
    const retryToken = randomUUID();
    expect(
      (
        await store.claim(tenant, retryToken, 60_000, {
          connectionConcurrency: 2,
        })
      )?.id,
    ).toBe(first!.id);
    await store.failPage(tenant, first!.id, retryToken, {
      code: 'transient',
      message: 'Try again',
      dueAt: new Date(Date.now() + 60_000).toISOString(),
      restart: false,
      block: null,
    });
    expect(
      await store.claim(tenant, randomUUID(), 60_000, {
        connectionConcurrency: 2,
      }),
    ).toBeNull();
    await owner.query(
      'UPDATE commerce_sync_streams SET due_at=now() WHERE tenant_id=$1 AND id=$2',
      [tenant, first!.id],
    );
    const finishToken = randomUUID();
    await store.claim(tenant, finishToken, 60_000, {
      connectionConcurrency: 2,
    });
    await store.commitPage(tenant, first!.id, finishToken, {
      ...empty,
      nextCursor: null,
      complete: { nextDueAt: new Date(Date.now() + 60_000).toISOString() },
    });
    const hinted = await store.claim(tenant, randomUUID(), 60_000, {
      connectionConcurrency: 2,
    });
    expect(hinted?.id).toBe(first!.id);
    expect(hinted?.scan).toBeNull();
    expect(hinted?.hintAt).not.toBeNull();
  });

  it('schedules a change read from a verified notification', async () => {
    source.set(shop, 'orders.read', [order(shop, '1')]);
    await drain();
    await owner.query(
      "UPDATE commerce_sync_streams SET due_at=now()+interval '1 hour' WHERE tenant_id=$1",
      [tenant],
    );
    await owner.query(
      "INSERT INTO connector_refresh_hints(tenant_id,connection_id,event_key,capabilities,received_at) VALUES($1,$2,'e1',ARRAY['orders.read'],now()-interval '1 minute')",
      [tenant, shop],
    );
    await drain();
    const run = await owner.query<{ trigger: string; kind: string }>(
      "SELECT r.trigger,r.kind FROM commerce_sync_runs r JOIN commerce_sync_streams s ON s.id=r.stream_id WHERE s.record_type='orders' ORDER BY r.started_at DESC LIMIT 1",
    );
    expect(run.rows[0]).toEqual({ trigger: 'webhook', kind: 'incremental' });
  });

  it('keeps customer profiles erasable and does not import erased customers again', async () => {
    source.set(shop, 'customers.read', [
      customer(shop, 'gid://shopify/Customer/1'),
      customer(shop, 'gid://shopify/Customer/2'),
    ]);
    await drain();
    const profiles = createCustomerProfiles(db);
    expect(
      (await profiles.list(context(), { q: 'ada', limit: 10 })).map(
        (profile) => profile.email,
      ),
    ).toEqual(['ada@example.test', 'ada@example.test']);
    await owner.query(
      'INSERT INTO shopify_installation_bindings(tenant_id,app,shop,connection_id) VALUES($1,$2,$3,$4)',
      [tenant, 'test:app', 'fixture.myshopify.com', shop],
    );
    await runtime.query('SELECT erase_shopify_customer_data($1,$2,$3)', [
      'test:app',
      'fixture.myshopify.com',
      ['gid://shopify/Customer/1'],
    ]);
    await service.command(
      context(),
      (await stream('customers'))!.id,
      'reimport',
    );
    await drain();
    const stored = await owner.query<{ external_id: string }>(
      'SELECT external_id FROM customer_profiles WHERE tenant_id=$1',
      [tenant],
    );
    expect(stored.rows).toEqual([{ external_id: 'gid://shopify/Customer/2' }]);
    const checks = await owner.query<{ document: { value: { items: [] } } }>(
      "SELECT document FROM connector_read_checks WHERE capability='customers.read'",
    );
    expect(
      checks.rows.every((row) => row.document.value.items.length === 0),
    ).toBe(true);
  });

  it('links equivalent SKUs from two sources on request and separates them again', async () => {
    source.set(shop, 'products.read', [product(shop, 'p1', 'item-1', 'ABC-1')]);
    source.set(shop, 'inventory.read', [stock(shop, 'item-1', '4')]);
    source.set(erp, 'products.read', [product(erp, 'p9', 'sku-9', 'abc-1 ')]);
    source.set(erp, 'inventory.read', [stock(erp, 'sku-9', '7')]);
    await drain();
    const skuOf = async (connectionId: string) =>
      (
        await owner.query<{ canonical_id: string }>(
          "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='sku'",
          [tenant, connectionId],
        )
      ).rows[0]!.canonical_id;
    const shopSku = await skuOf(shop);
    const erpSku = await skuOf(erp);
    expect(shopSku).not.toBe(erpSku);

    const identity = await service.identity(context(), 'sku', shopSku);
    expect(identity.entity.label).toBe('ABC-1');
    expect(identity.suggestions).toMatchObject([
      { id: erpSku, reason: 'Same SKU code “abc-1 ”' },
    ]);
    await expect(
      service.requestLink(context('viewer'), {
        operation: 'link',
        kind: 'sku',
        entityId: shopSku,
        otherId: erpSku,
        reason: 'Same mug',
      }),
    ).rejects.toThrow();
    const request = await service.requestLink(context(), {
      operation: 'link',
      kind: 'sku',
      entityId: shopSku,
      otherId: erpSku,
      reason: 'Same mug',
    });
    await drain();
    expect(await service.linkRequest(context(), request.id)).toMatchObject({
      state: 'completed',
    });
    expect(await skuOf(erp)).toBe(shopSku);
    // Locations stay separate until they are linked too, so each source keeps its position.
    const positionSkus = async () =>
      (
        await owner.query<{ sku_id: string }>(
          "SELECT s.sku_id FROM inventory_projections p JOIN inventory_snapshots s ON s.id=p.snapshot_id WHERE p.tenant_id=$1 AND s.kind='position' ORDER BY p.connection_id",
          [tenant],
        )
      ).rows.map((row) => row.sku_id);
    expect(await positionSkus()).toEqual([shopSku, shopSku]);
    expect(
      (await service.identity(context(), 'sku', shopSku)).sources.map(
        (item) => item.connectionId,
      ),
    ).toEqual(expect.arrayContaining([shop, erp]));
    expect(
      (
        await owner.query(
          'SELECT count(*) FROM inventory_projection_retirements WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].count,
    ).toBe('1');

    runner = createSyncRunner({
      store: createSyncStore(db),
      reader: source.reader,
      ingestion: services.ingestion,
      customers: createCustomerProfiles(db),
      recordRead: createReadChecks(db),
      resolveContext: async (principal) => context(principal),
      digest: (value) => createHash('sha256').update(value).digest('hex'),
      connectionConcurrency: 2,
      workspaceConcurrency: 4,
    });
    for (const item of (await createSyncStore(db).streams(tenant)).filter(
      (item) => ['products', 'inventory'].includes(item.recordType),
    ))
      await service.command(context(), item.id, 'reimport');
    await drain();
    expect(await skuOf(shop)).toBe(shopSku);
    expect(await skuOf(erp)).toBe(shopSku);
    expect(await positionSkus()).toEqual([shopSku, shopSku]);

    await service.requestLink(context(), {
      operation: 'unlink',
      kind: 'sku',
      entityId: shopSku,
      connectionId: erp,
      reason: 'Different size',
    });
    await drain();
    expect(await skuOf(erp)).toBe(erpSku);
    expect((await positionSkus()).sort()).toEqual([shopSku, erpSku].sort());
    const revisions = await owner.query<{ method: string; reason: string }>(
      'SELECT method,reason FROM connector_mapping_revisions WHERE tenant_id=$1 ORDER BY created_at',
      [tenant],
    );
    expect(revisions.rows.map((row) => row.reason)).toEqual([
      'Same mug',
      'Different size',
    ]);
  });

  async function canonical(
    connectionId: string,
    resource: string,
    externalId: string,
  ) {
    return (
      await owner.query<{ canonical_id: string }>(
        'SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource=$3 AND external_id=$4',
        [tenant, connectionId, resource, externalId],
      )
    ).rows[0]!.canonical_id;
  }

  const queries = {
    state: orderStateQueries,
    attention: orderAttentionQuery,
    attentionFor: orderAttentionForOrders,
  };

  function workspace() {
    return createOrderWorkspace(
      db,
      queries,
      createActivityStore,
      async (value) => value,
    );
  }

  it('links imported orders with independent children, preserves old evidence and URLs, and unlinks with fresh children', async () => {
    source.set(shop, 'orders.read', [order(shop, '1')]);
    source.set(erp, 'orders.read', [
      order(erp, '9', { externalNumber: '#1', number: 'SO-9' }),
    ]);
    source.set(erp, 'fulfillment.read', [shipment(erp, 'f9', '9')]);
    await drain();
    const a = await canonical(shop, 'order', '1'),
      b = await canonical(erp, 'order', '9');
    const oldLine = await canonical(erp, 'order_line', '9-line'),
      oldShipment = await canonical(erp, 'fulfillment', 'f9');
    const old = (await services.orders.current(context(), b))[0]!;
    await expect(
      services.orders.project(context(), {
        ...old.snapshot,
        entityId: a,
        mappingVersion: 'a'.repeat(64),
      }),
    ).rejects.toThrow('Canonical child belongs to another order');
    const issue = randomUUID();
    await owner.query(
      `INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,'escalated',$4)`,
      [
        issue,
        tenant,
        'f'.repeat(64),
        {
          id: issue,
          tenantId: tenant,
          fingerprint: 'f'.repeat(64),
          occurrenceCount: 1,
          firstDetectedAt: new Date().toISOString(),
          state: 'escalated',
          exceptionClass: 'stuck_fulfillment',
          severity: 'high',
          subject: {
            ruleIdentity: 'fixture',
            subjectKind: 'order',
            subjectId: b,
            scope: [],
          },
          lastDetectedAt: new Date().toISOString(),
        },
      ],
    );
    await owner.query(
      'INSERT INTO exception_outbox(id,tenant_id,exception_id,document) VALUES($1,$2,$3,$4)',
      [
        randomUUID(),
        tenant,
        issue,
        { type: 'exception.detected', occurredAt: new Date().toISOString() },
      ],
    );
    const request = await service.requestLink(context(), {
      operation: 'link',
      kind: 'order',
      entityId: a,
      otherId: b,
      reason: 'Shopify marketplace reference confirmed',
    });
    await drain();
    expect(await service.linkRequest(context(), request.id)).toMatchObject({
      state: 'completed',
    });
    expect(await canonical(erp, 'order', '9')).toBe(a);
    const linkedLine = await canonical(erp, 'order_line', '9-line');
    expect(linkedLine).not.toBe(oldLine);
    expect(await canonical(erp, 'fulfillment', 'f9')).not.toBe(oldShipment);
    const detail = await workspace().get(context(), b);
    expect(detail).toMatchObject({
      redirectedFrom: b,
      order: { id: a },
      sources: [expect.anything(), expect.anything()],
    });
    expect(detail?.issues.map((item) => item.id)).toContain(issue);
    expect(detail?.activity.entries.map((item) => item.exceptionId)).toContain(
      issue,
    );
    expect(detail?.history.entries.some((item) => item.entityId === b)).toBe(
      true,
    );
    expect(detail?.fulfillments).toHaveLength(1);
    expect(
      (
        await workspace().list(context(), {
          q: 'SO-9',
          view: 'all',
          sort: 'updated',
          direction: 'desc',
          limit: 50,
          count: 'exact',
        })
      ).items.map((item) => item.id),
    ).toEqual([a]);
    const metrics = await createOrderMetricReader(db, orderAttentionQuery)(
      context(),
      { asOf: new Date().toISOString(), scope: {}, limit: 50, offset: 0 },
    );
    expect(metrics.population).toBe(1);
    const records = createRecordExplorer(db);
    expect((await records.get(context(), 'order', b))?.record.id).toBe(a);
    expect(
      (await records.get(context(), 'fulfillment', oldShipment))?.record.id,
    ).toBe(await canonical(erp, 'fulfillment', 'f9'));
    expect(await services.orders.history(context(), b)).toHaveLength(1);
    expect(await services.orders.current(context(), b)).toEqual([]);

    // Reimport and reconciliation must retain the link and current child identities.
    for (const command of ['reimport', 'reconcile'] as const) {
      await service.command(
        context(),
        (await stream('orders', erp))!.id,
        command,
      );
      await drain();
      expect(await canonical(erp, 'order', '9')).toBe(a);
      expect(await canonical(erp, 'order_line', '9-line')).toBe(linkedLine);
      expect(
        (
          await workspace().list(context(), {
            q: '',
            view: 'all',
            sort: 'updated',
            direction: 'desc',
            limit: 50,
          })
        ).items,
      ).toHaveLength(1);
    }
    // A new shipment and a newer order arrive under the link; a later-delivered stale read cannot re-split it.
    source.set(erp, 'fulfillment.read', [
      shipment(erp, 'f9', '9'),
      shipment(erp, 'f10', '9'),
    ]);
    await service.command(
      context(),
      (await stream('fulfillments', erp))!.id,
      'reimport',
    );
    await drain();
    expect((await workspace().get(context(), a))?.fulfillments).toHaveLength(2);
    source.set(erp, 'orders.read', [
      order(erp, '9', {
        updated: '2026-10-01T10:00:00Z',
        status: 'completed',
        extraLine: true,
      }),
    ]);
    await service.command(
      context(),
      (await stream('orders', erp))!.id,
      'reimport',
    );
    await drain();
    source.set(erp, 'orders.read', [
      order(erp, '9', { updated: '2026-09-01T10:00:00Z', status: 'open' }),
    ]);
    await service.command(
      context(),
      (await stream('orders', erp))!.id,
      'reimport',
    );
    await drain();
    expect(
      (await services.orders.current(context(), a)).find(
        (item) => item.snapshot.connectionId === erp,
      )?.snapshot.data,
    ).toMatchObject({ status: 'completed' });
    expect(await canonical(erp, 'order', '9')).toBe(a);
    const addedLine = await canonical(erp, 'order_line', '9-added');
    expect(await services.orders.childParent(context(), addedLine)).toBe(a);

    const split = await service.requestLink(context(), {
      operation: 'unlink',
      kind: 'order',
      entityId: a,
      connectionId: erp,
      reason: 'Source order is separate',
    });
    await drain();
    expect(await service.linkRequest(context(), split.id)).toMatchObject({
      state: 'completed',
    });
    expect(await canonical(erp, 'order', '9')).toBe(b);
    const splitLine = await canonical(erp, 'order_line', '9-line');
    expect([oldLine, linkedLine]).not.toContain(splitLine);
    const splitAddedLine = await canonical(erp, 'order_line', '9-added');
    expect(splitAddedLine).not.toBe(addedLine);
    expect(await services.orders.childParent(context(), splitAddedLine)).toBe(
      b,
    );
    expect(
      (
        await workspace().list(context(), {
          q: '',
          view: 'all',
          sort: 'updated',
          direction: 'desc',
          limit: 50,
        })
      ).items,
    ).toHaveLength(2);
    expect(
      (await workspace().get(context(), b))?.issues.map((item) => item.id),
    ).toContain(issue);
    expect((await workspace().get(context(), b))?.fulfillments).toHaveLength(2);
    const audit = await owner.query<{ reason: string; actor_id: string }>(
      "SELECT reason,actor_id FROM connector_mapping_revisions WHERE tenant_id=$1 AND resource='order' ORDER BY created_at",
      [tenant],
    );
    expect(audit.rows).toEqual([
      {
        reason: 'Shopify marketplace reference confirmed',
        actor_id: 'operator',
      },
      { reason: 'Source order is separate', actor_id: 'operator' },
    ]);
    // Repeated retries leave the split untouched.
    await services.ingestion.unlink(
      context(),
      'order',
      a,
      erp,
      'Source order is separate',
    );
    expect(await canonical(erp, 'order_line', '9-line')).toBe(splitLine);
  });

  it('rolls back a crash during a link and resumes an expired request without duplicate effects', async () => {
    source.set(shop, 'orders.read', [order(shop, '1')]);
    source.set(erp, 'orders.read', [order(erp, '9')]);
    source.set(erp, 'fulfillment.read', [shipment(erp, 'f9', '9')]);
    await drain();
    const a = await canonical(shop, 'order', '1'),
      b = await canonical(erp, 'order', '9');
    const request = await service.requestLink(context(), {
      operation: 'link',
      kind: 'order',
      entityId: a,
      otherId: b,
      reason: 'Confirmed reference',
    });
    await createSyncStore(db).claimLink(tenant, 60_000);
    const interrupted = createCommerceServices({
      transaction: (tenantId, next, options) =>
        db.transaction(
          tenantId,
          (tx) =>
            next({
              query: async <Row extends Record<string, unknown>>(
                sql: string,
                values?: unknown[],
              ) => {
                if (sql.startsWith('INSERT INTO orders_projection_retirements'))
                  throw new Error('Simulated worker crash');

                return tx.query<Row>(sql, values);
              },
            }),
          options,
        ),
    });
    await expect(
      interrupted.ingestion.link(
        context(),
        'order',
        a,
        b,
        'Confirmed reference',
      ),
    ).rejects.toThrow('Simulated worker crash');
    expect(await canonical(erp, 'order', '9')).toBe(b);
    expect(await services.orders.current(context(), a)).toHaveLength(1);
    expect(await services.orders.current(context(), b)).toHaveLength(1);
    await owner.query(
      "UPDATE commerce_identity_links SET lease_until=now()-interval '1 second' WHERE tenant_id=$1",
      [tenant],
    );
    await drain();
    expect(await service.linkRequest(context(), request.id)).toMatchObject({
      state: 'completed',
    });
    const count = (
      await owner.query(
        'SELECT count(*) FROM orders_snapshots WHERE tenant_id=$1',
        [tenant],
      )
    ).rows[0].count;
    // Crash after the atomic link committed, but before the queue completion was written.
    await owner.query(
      "UPDATE commerce_identity_links SET state='running',lease_until=now()-interval '1 second' WHERE tenant_id=$1",
      [tenant],
    );
    await drain();
    expect(await service.linkRequest(context(), request.id)).toMatchObject({
      state: 'completed',
    });
    expect(
      (
        await owner.query(
          'SELECT count(*) FROM orders_snapshots WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].count,
    ).toBe(count);
    expect(await services.orders.current(context(), a)).toHaveLength(2);
  });

  it('keeps ambiguous suggestions unapplied and rejects unauthorized, same-connection and foreign links', async () => {
    source.set(shop, 'orders.read', [order(shop, '1')]);
    source.set(erp, 'orders.read', [
      order(erp, '9', { externalNumber: '1' }),
      order(erp, '10', { externalNumber: '#1' }),
      order(erp, '11'),
    ]);
    await drain();
    const a = await canonical(shop, 'order', '1'),
      b = await canonical(erp, 'order', '9'),
      c = await canonical(erp, 'order', '10');
    const identity = await service.identity(context(), 'order', a);
    expect(identity.suggestions.map((item) => item.id).sort()).toEqual(
      [b, c].sort(),
    );
    expect(identity.sources[0]?.order?.total).toEqual({
      amount: '10.00',
      currency: 'EUR',
    });
    expect(await canonical(erp, 'order', '9')).toBe(b);
    await expect(
      service.requestLink(context('viewer'), {
        operation: 'link',
        kind: 'order',
        entityId: a,
        otherId: b,
        reason: 'Confirmed',
      }),
    ).rejects.toThrow();
    await expect(
      service.requestLink(context(), {
        operation: 'link',
        kind: 'order',
        entityId: b,
        otherId: c,
        reason: 'Confirmed',
      }),
    ).rejects.toThrow('same connection');
    await expect(
      service.requestLink(context(), {
        operation: 'link',
        kind: 'order',
        entityId: a,
        otherId: randomUUID(),
        reason: 'Confirmed',
      }),
    ).rejects.toThrow('Record not found');
    await expect(
      service.identity({ ...context(), tenantId: randomUUID() }, 'order', a),
    ).rejects.toThrow('Record not found');
    await expect(
      service.requestLink(context(), {
        operation: 'link',
        kind: 'order',
        entityId: a,
        otherId: b,
        reason: ' ',
      }),
    ).rejects.toThrow('Give a reason');
  });

  it('leaves idle workspaces and connections without syncable reads unscheduled', async () => {
    await drain();
    expect(await runner.scopes()).not.toContain(tenant);
    const other = randomUUID();
    await owner.query(
      'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
      [
        tenant,
        other,
        {
          id: other,
          tenantId: tenant,
          version: 1,
          status: 'active',
          provider: 'jtl',
          target: { kind: 'jtl-cloud' },
          label: 'Corrections only',
          permissions: ['orders.shipping-method.read'],
          granted: ['orders.shipping-method.read'],
        },
        'encrypted-fixture',
      ],
    );
    await owner.query(
      `INSERT INTO connector_lifecycle_events(tenant_id,connection_id,version,event,actor_id,status,credential_version)
      VALUES($1,$2,1,'installed','operator','active',1)`,
      [tenant, other],
    );
    expect(await runner.scopes()).not.toContain(tenant);
    await owner.query(
      `UPDATE connector_installations SET document=jsonb_set(document,'{status}','"degraded"')
      WHERE tenant_id=$1 AND id=$2`,
      [tenant, shop],
    );
    expect(await runner.scopes()).toContain(tenant);
    await drain();
    expect(await stream('orders')).toMatchObject({
      blocked: 'connection_inactive',
    });
    expect(await runner.scopes()).not.toContain(tenant);
  });

  it('pauses when the person it runs as loses access until someone resumes it', async () => {
    source.set(shop, 'orders.read', [order(shop, '1')]);
    members.delete('operator');
    try {
      await drain();
      expect(await stream('orders')).toMatchObject({
        blocked: 'principal_unavailable',
        phase: 'backfill',
      });
      members.set('admin', 'admin');
      await service.command(
        context('admin'),
        (await stream('orders'))!.id,
        'resume',
      );
      await drain();
      expect(await stream('orders')).toMatchObject({
        blocked: null,
        phase: 'incremental',
        principal_id: 'admin',
      });
    } finally {
      members.set('operator', 'owner');
      members.delete('admin');
    }
  });

  it('imports a page together and fails only the record that breaks record rules', async () => {
    const broken = order(shop, '2');
    (
      broken.data as { lines: { quantity: { amount: string } }[] }
    ).lines[0]!.quantity.amount = '0';
    source.set(shop, 'orders.read', [
      order(shop, '1'),
      broken,
      order(shop, '3', { number: 'SEARCH-3' }),
    ]);
    await drain();

    const items = await owner.query(
      `SELECT external_id,status,problem FROM commerce_sync_items
      WHERE tenant_id=$1 AND record_type='orders' ORDER BY external_id`,
      [tenant],
    );
    expect(items.rows).toEqual([
      { external_id: '1', status: 'current', problem: null },
      {
        external_id: '2',
        status: 'failed',
        problem: 'The source record does not match Luma’s record rules',
      },
      { external_id: '3', status: 'current', problem: null },
    ]);
    // Maintained reads are refreshed for every record projected in the page.
    const listed = await owner.query(
      `SELECT o.display_number,count(k.value_id)::int AS search_values FROM orders_list o
      LEFT JOIN orders_search_links k ON k.tenant_id=o.tenant_id AND k.entity_id=o.entity_id
      WHERE o.tenant_id=$1 GROUP BY o.display_number ORDER BY o.display_number`,
      [tenant],
    );
    expect(listed.rows).toEqual([
      { display_number: '#1', search_values: 2 },
      { display_number: 'SEARCH-3', search_values: 2 },
    ]);
  });

  it('imports overlapping streams from several connections concurrently', async () => {
    const skus = Array.from({ length: 30 }, (_, index) => `item-${index}`);
    for (const connectionId of [shop, erp]) {
      source.set(
        connectionId,
        'products.read',
        skus.map((sku, index) =>
          product(connectionId, `p-${index}`, sku, `CODE-${index}`),
        ),
      );
      source.set(
        connectionId,
        'inventory.read',
        skus.map((sku, index) => stock(connectionId, sku, String(index))),
      );
      source.set(
        connectionId,
        'orders.read',
        skus.map((sku, index) =>
          order(connectionId, `o-${index}`, { sku, extraLine: index % 2 > 0 }),
        ),
      );
      source.set(
        connectionId,
        'fulfillment.read',
        skus.map((_, index) =>
          shipment(connectionId, `f-${index}`, `o-${index}`),
        ),
      );
    }
    const parallel = createSyncRunner({
      store: createSyncStore(db),
      reader: source.reader,
      ingestion: services.ingestion,
      customers: createCustomerProfiles(db),
      recordRead: createReadChecks(db),
      resolveContext: async (principal) => context(principal),
      digest: (value) => createHash('sha256').update(value).digest('hex'),
      pageSize: 5,
      workspaceConcurrency: 8,
      connectionConcurrency: 4,
    });
    for (
      let pass = 0;
      pass < 50 && (await parallel.scopes()).includes(tenant);
      pass++
    )
      await parallel.tick(tenant, 5000);

    const statuses = await owner.query(
      'SELECT status,count(*)::int AS count FROM commerce_sync_items WHERE tenant_id=$1 GROUP BY status',
      [tenant],
    );
    expect(statuses.rows).toEqual([{ status: 'current', count: 240 }]);
    const failing = await owner.query(
      'SELECT record_type,error_code FROM commerce_sync_streams WHERE tenant_id=$1 AND error_code IS NOT NULL',
      [tenant],
    );
    expect(failing.rows).toEqual([]);
    const counts = await owner.query(
      `SELECT (SELECT count(*)::int FROM inventory_entities WHERE tenant_id=$1 AND kind='sku') AS skus,
        (SELECT count(*)::int FROM inventory_entities WHERE tenant_id=$1 AND kind='position') AS positions,
        (SELECT count(*)::int FROM orders_list WHERE tenant_id=$1) AS orders,
        (SELECT count(*)::int FROM orders_fulfillment_list WHERE tenant_id=$1) AS fulfillments`,
      [tenant],
    );
    expect(counts.rows[0]).toEqual({
      skus: 60,
      positions: 60,
      orders: 60,
      fulfillments: 60,
    });
  });

  it('lets imports share the workspace while a link waits for them', async () => {
    const observe = (item: Item) => ({
      ...item,
      id: randomUUID(),
      observedAt: new Date().toISOString(),
    });
    const outcomes = await services.ingestion.importMany(context(), [
      {
        ingestKey: `test:${randomUUID()}`,
        input: {
          capability: 'products.read',
          observation: observe(product(shop, 'p1', 'item-1', 'ABC-1')),
        } as CommerceObservation,
      },
      {
        ingestKey: `test:${randomUUID()}`,
        input: {
          capability: 'products.read',
          observation: observe(product(erp, 'p9', 'sku-9', 'ABC-1')),
        } as CommerceObservation,
      },
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'applied',
      'applied',
    ]);
    const sku = async (connectionId: string) =>
      (
        await owner.query<{ canonical_id: string }>(
          "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='sku'",
          [tenant, connectionId],
        )
      ).rows[0]!.canonical_id;
    const lock = await owner.connect();
    try {
      // Another import holds the workspace lock for its whole transaction.
      await lock.query(
        'SELECT pg_advisory_lock_shared(hashtextextended($1,0))',
        [`commerce-ingestion:${tenant}`],
      );
      const imported = await services.ingestion.import(
        context(),
        `test:${randomUUID()}`,
        {
          capability: 'inventory.read',
          observation: observe(stock(shop, 'item-1', '3')),
        } as CommerceObservation,
      );
      expect(imported.status).toBe('applied');

      let linked = false;
      const link = services.ingestion
        .link(context(), 'sku', await sku(shop), await sku(erp), 'Same mug')
        .then(() => {
          linked = true;
        });
      await expect
        .poll(
          async () =>
            (
              await owner.query(
                "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted",
              )
            ).rows[0].count,
          { timeout: 5000 },
        )
        .toBe(1);
      expect(linked).toBe(false);
      await lock.query(
        'SELECT pg_advisory_unlock_shared(hashtextextended($1,0))',
        [`commerce-ingestion:${tenant}`],
      );
      await link;
      expect(await sku(erp)).toBe(await sku(shop));
    } finally {
      lock.release();
    }
  });

  it.skipIf(!process.env.LUMA_IMPORT_BENCHMARK)(
    'measures history import throughput',
    async () => {
      const count = Number(process.env.LUMA_IMPORT_BENCHMARK);
      // Fixture observations name Shopify as their provider.
      const install = async () => {
        const id = randomUUID();
        const provider = 'shopify';
        await owner.query(
          'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
          [
            tenant,
            id,
            {
              id,
              tenantId: tenant,
              version: 1,
              status: 'active',
              provider,
              target: { kind: provider },
              label: `Benchmark ${provider}`,
              permissions: reads,
              granted: reads,
            },
            'encrypted-fixture',
          ],
        );
        await owner.query(
          `INSERT INTO connector_lifecycle_events(tenant_id,connection_id,version,event,actor_id,status,credential_version)
          VALUES($1,$2,1,'installed','operator','active',1)`,
          [tenant, id],
        );
        for (const capability of reads) source.set(id, capability, []);

        return id;
      };
      // Production defaults: page size, workspace and connection concurrency.
      const bench = createSyncRunner({
        store: createSyncStore(db),
        reader: source.reader,
        ingestion: services.ingestion,
        customers: createCustomerProfiles(db),
        recordRead: createReadChecks(db),
        resolveContext: async (principal) => context(principal),
        digest: (value) => createHash('sha256').update(value).digest('hex'),
      });
      const results: Record<string, number>[] = [];
      const measured: Record<string, number> = {};

      async function phase(label: string, records: number) {
        const start = performance.now();
        for (
          let pass = 0;
          pass < 1_000 && (await bench.scopes()).includes(tenant);
          pass++
        )
          await bench.tick(tenant, 20_000);
        const ms = performance.now() - start;
        const failing = await owner.query(
          'SELECT record_type,error_code FROM commerce_sync_streams WHERE tenant_id=$1 AND error_code IS NOT NULL',
          [tenant],
        );
        expect(failing.rows).toEqual([]);
        measured[label] = Math.round((records / ms) * 1000);
        results.push({ [label]: Math.round(ms) });
      }

      const skus = Array.from({ length: count }, (_, index) => `sku-${index}`);
      const catalog = await install();
      source.set(
        catalog,
        'products.read',
        skus.map((sku, index) => product(catalog, `p-${index}`, sku, sku)),
      );
      await phase('products', count);
      source.set(
        catalog,
        'inventory.read',
        skus.map((sku, index) => stock(catalog, sku, String(index % 50))),
      );
      const inventory = await owner.query<{ id: string }>(
        "SELECT id FROM commerce_sync_streams WHERE tenant_id=$1 AND connection_id=$2 AND record_type='inventory'",
        [tenant, catalog],
      );
      await service.command(context(), inventory.rows[0]!.id, 'reimport');
      await phase('inventory', count);
      const store = await install();
      source.set(
        store,
        'orders.read',
        skus.map((sku, index) =>
          order(store, `o-${index}`, { sku, extraLine: true }),
        ),
      );
      await phase('orders', count);
      source.set(
        store,
        'fulfillment.read',
        skus.map((_, index) => shipment(store, `f-${index}`, `o-${index}`)),
      );
      const fulfillments = await owner.query<{ id: string }>(
        "SELECT id FROM commerce_sync_streams WHERE tenant_id=$1 AND connection_id=$2 AND record_type='fulfillments'",
        [tenant, store],
      );
      await service.command(context(), fulfillments.rows[0]!.id, 'reimport');
      await phase('fulfillments', count);
      const stores = [await install(), await install()];
      for (const id of stores)
        source.set(
          id,
          'orders.read',
          skus.map((sku, index) =>
            order(id, `o-${index}`, { sku, extraLine: true }),
          ),
        );
      await phase('orders from two connections', count * 2);

      const failed = await owner.query(
        "SELECT count(*)::int AS count FROM commerce_sync_items WHERE tenant_id=$1 AND status<>'current'",
        [tenant],
      );
      expect(failed.rows[0].count).toBe(0);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        `/tmp/luma-import-benchmark-${count}.json`,
        JSON.stringify({ recordsPerSecond: measured, ms: results }, null, 2),
      );
    },
    3_600_000,
  );
});
