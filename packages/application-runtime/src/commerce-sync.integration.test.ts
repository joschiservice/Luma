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
  Observation,
  ReadCapability,
} from '@luma/connections';
import { createReadChecks } from '@luma/connections/composition';
import { createCustomerProfiles } from '@luma/customers/composition';
import type { TenantContext } from '@luma/identity';
import { makeTenantContext } from '@luma/identity/composition';
import type { TenantDatabase } from '@luma/platform';
import { createTenantDatabase } from '@luma/platform/composition';
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
function provider(tenantId: string) {
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
  }[] = [];
  let historyLimited = true;
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
              ? { filters: ['updatedSince' as const] }
              : {}),
          }))
        : [];
    },
    async read(_context, request) {
      const input = request.input as {
        limit: number;
        cursor?: string;
        updatedSince?: string;
      };
      requests.push({
        connectionId: request.connectionId,
        capability: request.capability,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.updatedSince ? { updatedSince: input.updatedSince } : {}),
      });
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
      ).filter(
        (item) =>
          !input.updatedSince ||
          (item.sourceUpdatedAt ?? '') >= input.updatedSince,
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
        provider: 'shopify',
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
      { id: `m-${user}`, organizationId: tenant, userId: user, role },
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
    } = {},
  ): Item => ({
    source: source.source(connectionId, 'order', id),
    kind: 'snapshot',
    sourceUpdatedAt: options.updated ?? '2026-09-01T10:00:00.000Z',
    sourceRevision: null,
    adapterVersion: 'fixture/1',
    schemaVersion: 1,
    data: {
      displayNumber: `#${id}`,
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
      `GRANT luma_connectors,luma_orders,luma_inventory,luma_case_reader,luma_commerce_sync,luma_customers TO "${name}"`,
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
            provider: 'shopify',
            target: { kind: 'shopify' },
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
    source = provider(tenant);
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
});
