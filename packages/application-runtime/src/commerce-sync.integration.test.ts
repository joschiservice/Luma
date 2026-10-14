import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { createShopifyConnector } from '@luma/app-shopify';
import { createCommerceServices } from '@luma/application-runtime';
import { createAutomaticLinkStore } from '@luma/application-runtime/sync';
import {
  createAutoLinkRunner,
  createAutoLinkService,
  createSyncRunner,
  createSyncService,
} from '@luma/commerce-sync';
import {
  createAutoLinkStore,
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
import { createCapabilityRuntime } from '@luma/connections/adapters';
import {
  createReadChecks,
  createSourceAuthority,
} from '@luma/connections/composition';
import { createCustomerProfiles } from '@luma/customers/composition';
import {
  orderAttentionForOrders,
  orderAttentionQuery,
} from '@luma/exceptions/composition';
import { PermissionSet, type TenantContext } from '@luma/identity';
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
  createCustomerWorkspace,
  createOrderWorkspace,
  createRecordExplorer,
} from '@luma/read-models/composition';
import { createActivityStore } from '@luma/resolution/composition';
import { createMemoryStore } from '@luma/simulator-core';
import { shopify, type ShopifyConfig } from '@luma/simulator-shopify';
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
    admission?: boolean;
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
        const [failed] = failures.splice(failure, 1);

        return {
          ok: false,
          error: failed?.admission
            ? {
                code: 'rate_limited',
                providerCode: 'ADMISSION_DEFERRED',
                effect: 'none',
                retry: 'after_delay',
                retryAfterMs: 60000,
              }
            : { code: 'transient', effect: 'none', retry: 'after_delay' },
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
    defer(connectionId: string, capability: string, cursor?: string) {
      failures.push({
        connectionId,
        capability,
        admission: true,
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
  let workspaceStatus: 'active' | 'suspended' = 'active';

  function context(user = 'operator'): TenantContext {
    const role = members.get(user);
    if (!role) throw new Error('Membership not found');

    return makeTenantContext(
      { userId: user, sessionId: 'session' },
      {
        id: tenant,
        name: 'Fixture',
        slug: 'fixture',
        status: workspaceStatus,
        dataRegion: 'AU',
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
      /** Source customer ID, or null for a guest order; omitted when not read. */
      customer?: string | null;
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
      ...(options.customer === undefined
        ? {}
        : {
            customer: options.customer
              ? { externalId: options.customer, scopeKey: '' }
              : null,
          }),
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
    await owner.query('SELECT luma_provision_cell_region($1)', ['AU']);
    // Sync discovery returns active workspaces only.
    await owner.query(
      "INSERT INTO organizations(data_region,id,name,slug,created_at) VALUES('AU',$1,'Fixture',$2,now())",
      [tenant, `fixture-${tenant}`],
    );
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
        customer_profiles,customer_erasures,customer_orders,customer_order_addresses,connector_refresh_hints,connector_read_checks,
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
      automaticLinks: createAutoLinkRunner({
        store: createAutomaticLinkStore(db),
        resolveContext: async (principal) => context(principal),
        log: () => undefined,
      }),
      reader: source.reader,
      ingestion: services.ingestion,
      customers: createCustomerProfiles(db),
      recordRead: createReadChecks(db),
      resolveContext: async (principal) => context(principal),
      digest: (value) => createHash('sha256').update(value).digest('hex'),
      pageSize: 2,
    });
    service = createSyncService({
      automaticLinks: createAutoLinkService({
        store: createAutomaticLinkStore(db),
        refreshContext: async (value) => context(value.actor.id),
      }),
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

  it('confirms missed Shopify deletions through simulator reads, preserves history and restores reappearing facts', async () => {
    const store = createMemoryStore();
    const config: ShopifyConfig = {
      shop: 'fixture.myshopify.com',
      name: 'Fixture',
      currency: 'EUR',
      orderPrefix: 'T',
      locations: [{ id: '1', name: 'Warehouse' }],
      scopes: [
        'read_orders',
        'read_all_orders',
        'read_products',
        'read_inventory',
      ],
    };
    const simulated = {
      store,
      config,
      instance: 'shop',
      now: Date.now(),
      wallTime: Date.now(),
      indexLagMs: 0,
      notify: () => undefined,
    };
    await shopify.command(simulated, {
      kind: 'seed-catalog',
      products: [
        {
          id: '10',
          title: 'Tote',
          vendor: 'Fixture',
          productType: 'Bag',
          published: true,
          variants: [
            {
              id: '11',
              sku: 'TOTE',
              title: 'Default Title',
              price: '10.00',
              barcode: null,
              stock: { '1': 5 },
            },
          ],
        },
      ],
    });
    const created = await shopify.command(simulated, {
      kind: 'order',
      lines: [{ variant: '11', quantity: 1, price: '10.00' }],
      location: '1',
      shipping: 'standard',
      financialStatus: 'PAID',
    });
    const orderRecord = await store.get('Order', created.id);
    const product = await store.get('Product', '10');
    const level = (await store.page({ kind: 'InventoryLevel', limit: 10 }))
      .items[0]!;
    const connector = createShopifyConnector({
      tenantId: tenant,
      connectionId: shop,
      shop: config.shop,
      accessToken: async () => 'synthetic',
      recordObservations: async () => undefined,
      fetch: async (url, init) => {
        const response = await shopify.handle(simulated, {
          url: String(url),
          method: 'POST',
          headers: Object.fromEntries(new Headers(init?.headers)),
          body: String(init?.body),
        });

        return Response.json(response.body, {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    const actual = createCapabilityRuntime({
      resolve: async () => connector,
      record: async () => undefined,
    });
    await owner.query(
      `UPDATE connector_installations SET document=jsonb_set(jsonb_set(document,'{granted}',$3::jsonb),'{permissions}',$3::jsonb) WHERE tenant_id=$1 AND id=$2`,
      [
        tenant,
        shop,
        JSON.stringify(['orders.read', 'products.read', 'inventory.read']),
      ],
    );
    runner = createSyncRunner({
      store: createSyncStore(db),
      reader: {
        discover: async (ctx, id) =>
          (await actual.discover(ctx, id)).map((item) => ({
            ...item,
            ...(item.filters
              ? {
                  filters: item.filters.filter(
                    (filter) => filter !== 'historyImport',
                  ),
                }
              : {}),
          })),
        read: actual.read,
      },
      ingestion: services.ingestion,
      customers: createCustomerProfiles(db),
      recordRead: createReadChecks(db),
      resolveContext: async () => context(),
      digest: (value) => createHash('sha256').update(value).digest('hex'),
    });
    await owner.query(
      `UPDATE connector_installations SET secret=NULL,document=jsonb_set(document,'{status}','"disconnected"') WHERE tenant_id=$1 AND id=$2`,
      [tenant, erp],
    );
    await drain();
    const snapshots = async () =>
      (
        await owner.query<{ kind: string; deleted: boolean }>(
          `SELECT s.kind,(s.document->>'deleted')::boolean AS deleted FROM inventory_projections p JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id WHERE p.tenant_id=$1 ORDER BY s.kind`,
          [tenant],
        )
      ).rows;
    expect(await snapshots()).toEqual([
      { kind: 'position', deleted: false },
      { kind: 'product', deleted: false },
    ]);
    // The adapter's commercial facts reach the order record; this deployment reads no addresses.
    const imported = await workspace().get(
      context(),
      await canonical(shop, 'order', `gid://shopify/Order/${created.id}`),
    );
    expect(imported?.sources[0]).toMatchObject({
      currencies: { shop: 'EUR', presentment: 'EUR' },
      amounts: {
        total: { current: { shop: { amount: '10.0', currency: 'EUR' } } },
        duties: { original: null, current: null },
      },
      shippingLines: [{ title: 'Standard', removed: false }],
      discounts: [],
      tags: [],
      attributes: { channel: 'web', fulfillmentStatus: 'unfulfilled' },
      addresses: { state: 'not_shared', observedAt: expect.any(String) },
      lines: [{ catalog: 'variant', requiresShipping: true }],
    });
    const before = await owner.query(
      'SELECT count(*)::int AS count FROM connector_source_mappings WHERE tenant_id=$1',
      [tenant],
    );
    expect(
      (
        await createOrderMetricReader(db, orderAttentionQuery)(context(), {
          asOf: new Date().toISOString(),
          scope: {},
          limit: 50,
        })
      ).population,
    ).toBe(1);
    await store.delete('Order', created.id);
    await store.delete('Product', '10');
    await store.delete('InventoryLevel', level.id);
    for (const type of ['orders', 'products', 'inventory'] as const)
      await service.command(context(), (await stream(type))!.id, 'reconcile');
    await drain();
    // The full scan establishes missing; its next due page independently confirms it.
    await due();
    await drain();
    expect(await snapshots()).toEqual([
      { kind: 'position', deleted: true },
      { kind: 'product', deleted: true },
    ]);
    expect(
      (
        await owner.query(
          'SELECT status FROM commerce_sync_items WHERE tenant_id=$1 AND connection_id=$2 ORDER BY record_type',
          [tenant, shop],
        )
      ).rows,
    ).toEqual([
      { status: 'retired' },
      { status: 'retired' },
      { status: 'retired' },
    ]);
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS count FROM connector_source_mappings WHERE tenant_id=$1',
          [tenant],
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS count FROM inventory_snapshots WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0]?.count,
    ).toBe(4);
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS count FROM inventory_product_skus WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0]?.count,
    ).toBe(0);
    await due();
    await drain();
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS count FROM inventory_snapshots WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0]?.count,
    ).toBe(4);
    expect(
      (
        await createOrderMetricReader(db, orderAttentionQuery)(context(), {
          asOf: new Date().toISOString(),
          scope: {},
          limit: 50,
        })
      ).population,
    ).toBe(0);
    expect(
      (
        await owner.query(
          `SELECT count(*)::int AS count FROM orders_list WHERE tenant_id=$1 AND NOT deleted`,
          [tenant],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await owner.query(
          `SELECT count(*)::int AS count FROM orders_snapshots WHERE tenant_id=$1 AND kind='order'`,
          [tenant],
        )
      ).rows[0]?.count,
    ).toBe(2);
    await store.put('Order', created.id, orderRecord!.data, orderRecord!);
    await store.put('Product', '10', product!.data, product!);
    await store.put('InventoryLevel', level.id, level.data, level);
    for (const type of ['orders', 'products', 'inventory'] as const)
      await service.command(context(), (await stream(type))!.id, 'reconcile');
    await drain();
    expect(await snapshots()).toEqual([
      { kind: 'position', deleted: false },
      { kind: 'product', deleted: false },
    ]);
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS count FROM connector_source_mappings WHERE tenant_id=$1',
          [tenant],
        )
      ).rows,
    ).toEqual(before.rows);
  }, 30_000);

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

  it('defers admission without recording a failure or advancing the history checkpoint', async () => {
    source.set(shop, 'orders.read', [
      order(shop, '1'),
      order(shop, '2'),
      order(shop, '3'),
    ]);
    source.defer(shop, 'orders.read', '2');
    await drain();
    expect(await stream('orders')).toMatchObject({
      phase: 'backfill',
      cursor: '2',
      attempts: 0,
      error_code: null,
    });
    const current = (await createSyncStore(db).streams(tenant)).find(
      (item) => item.connectionId === shop && item.recordType === 'orders',
    );
    expect(current?.scan).toMatchObject({
      cursor: '2',
      pages: 1,
      waitingForExport: false,
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
  }, 30000);

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

  it('lists a customer’s orders from every source once and erases the order links with the profile', async () => {
    const ada = 'gid://shopify/Customer/1',
      grace = 'gid://shopify/Customer/2';
    source.set(shop, 'customers.read', [
      customer(shop, ada),
      customer(shop, grace),
    ]);
    source.set(erp, 'customers.read', [customer(erp, '501')]);
    source.set(shop, 'orders.read', [
      order(shop, '1', { customer: ada, placed: '2026-08-01T10:00:00.000Z' }),
      order(shop, '2', { customer: ada, placed: '2026-08-02T10:00:00.000Z' }),
      order(shop, '3', { customer: null }),
      order(shop, '4', { customer: grace }),
    ]);
    source.set(erp, 'orders.read', [
      order(erp, '9', {
        externalNumber: '#1',
        number: 'SO-9',
        customer: '501',
      }),
    ]);
    await drain();

    // Customer references never enter retained order evidence.
    const evidence = await owner.query(
      `SELECT 1 FROM connector_observations WHERE tenant_id=$1
      AND document->'observation'->'data' ? 'customer'`,
      [tenant],
    );
    expect(evidence.rowCount).toBe(0);
    const profile = async (connectionId: string, externalId: string) =>
      (
        await owner.query<{ id: string }>(
          'SELECT id FROM customer_profiles WHERE tenant_id=$1 AND connection_id=$2 AND external_id=$3',
          [tenant, connectionId, externalId],
        )
      ).rows[0]?.id;
    const lastOrder = async (connectionId: string, externalId: string) =>
      (
        await owner.query<{ last_order_at: Date | null }>(
          'SELECT last_order_at FROM customer_profiles WHERE tenant_id=$1 AND connection_id=$2 AND external_id=$3',
          [tenant, connectionId, externalId],
        )
      ).rows[0]?.last_order_at?.toISOString() ?? null;
    // Each profile keeps the latest placed date of the orders its source attributes to it.
    expect(await lastOrder(shop, ada)).toBe('2026-08-02T10:00:00.000Z');
    expect(await lastOrder(shop, grace)).toBe('2026-08-15T10:00:00.000Z');
    const ordersOf = async (customerId: string) =>
      (
        await workspace().list(context('viewer'), {
          q: '',
          view: 'all',
          sort: 'placed',
          direction: 'asc',
          limit: 50,
          count: 'exact',
          customerId,
        })
      ).items.map((item) => item.id);
    const adaId = (await profile(shop, ada))!;
    const one = await canonical(shop, 'order', '1'),
      two = await canonical(shop, 'order', '2');
    expect(await ordersOf(adaId)).toEqual([one, two]);
    expect(await ordersOf((await profile(erp, '501'))!)).toEqual([
      await canonical(erp, 'order', '9'),
    ]);
    // Which orders a customer placed is customer data, not only order data.
    const ordersOnly = context('viewer');
    await expect(
      workspace().list(
        makeTenantContext(
          { userId: 'viewer', sessionId: 'session' },
          {
            id: tenant,
            name: 'Fixture',
            slug: 'fixture',
            status: 'active',
            dataRegion: 'AU',
          },
          {
            ...builtInMembership(
              { id: 'm-viewer', organizationId: tenant, userId: 'viewer' },
              'member',
            ),
            permissions: new PermissionSet(['orders.read']),
          },
          ordersOnly.requestId,
        ),
        {
          q: '',
          view: 'all',
          sort: 'placed',
          direction: 'asc',
          limit: 50,
          customerId: adaId,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    // Linked across sources, the order keeps one row for each source's customer.
    await service.requestLink(context(), {
      operation: 'link',
      kind: 'order',
      entityId: one,
      otherId: await canonical(erp, 'order', '9'),
      reason: 'Marketplace reference confirmed',
    });
    await drain();
    // The linked order now sorts by the ERP's placed time; membership is what matters.
    expect((await ordersOf(adaId)).sort()).toEqual([one, two].sort());
    expect(await ordersOf((await profile(erp, '501'))!)).toEqual([one]);

    // A later read that names another customer moves the order.
    source.set(shop, 'orders.read', [
      order(shop, '1', { customer: ada, placed: '2026-08-01T10:00:00.000Z' }),
      order(shop, '2', {
        customer: grace,
        placed: '2026-08-02T10:00:00.000Z',
        updated: new Date().toISOString(),
      }),
      order(shop, '3', { customer: null }),
      order(shop, '4', { customer: grace }),
    ]);
    await due();
    await drain();
    expect(await ordersOf(adaId)).toEqual([one]);
    expect((await ordersOf((await profile(shop, grace))!)).sort()).toEqual(
      [two, await canonical(shop, 'order', '4')].sort(),
    );
    // Moving an order recomputes both customers' last order dates.
    expect(await lastOrder(shop, ada)).toBe('2026-08-01T10:00:00.000Z');
    expect(await lastOrder(shop, grace)).toBe('2026-08-15T10:00:00.000Z');

    await owner.query(
      'INSERT INTO shopify_installation_bindings(tenant_id,app,shop,connection_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [tenant, 'test:app', 'fixture.myshopify.com', shop],
    );
    await runtime.query('SELECT erase_shopify_customer_data($1,$2,$3)', [
      'test:app',
      'fixture.myshopify.com',
      [ada],
    ]);
    const links = await owner.query<{ customer_external_id: string }>(
      'SELECT customer_external_id FROM customer_orders WHERE tenant_id=$1 AND connection_id=$2 ORDER BY 1',
      [tenant, shop],
    );
    expect(links.rows.map((row) => row.customer_external_id)).toEqual([
      grace,
      grace,
    ]);
    expect(await ordersOf(adaId)).toEqual([]);

    // A full reread does not restore the erased customer's links.
    await service.command(context(), (await stream('orders'))!.id, 'reimport');
    await drain();
    expect(
      (
        await owner.query(
          'SELECT 1 FROM customer_orders WHERE tenant_id=$1 AND customer_external_id=$2',
          [tenant, ada],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('keeps order addresses out of order evidence, shows them only to customer readers and erases them', async () => {
    const ada = 'gid://shopify/Customer/1';
    const home = {
      line1: 'Hafenstraße 1',
      line2: null,
      city: 'Hamburg',
      region: null,
      postalCode: '20457',
      country: 'DE',
    };
    const orders = (updated: string) =>
      (
        [
          ['1', ada, { shared: true, shipping: home, billing: null }],
          ['2', null, { shared: true, shipping: home, billing: home }],
          ['3', undefined, { shared: false }],
        ] as const
      ).map(([id, customer, addresses]) => {
        const item = order(shop, `gid://shopify/Order/${id}`, {
          updated,
          ...(customer === undefined ? {} : { customer }),
        });

        return { ...item, data: { ...(item.data as object), addresses } };
      });
    source.set(shop, 'orders.read', orders('2026-09-01T10:00:00.000Z'));
    source.set(erp, 'orders.read', [order(erp, '9')]);
    await drain();

    // Addresses never enter retained order evidence or snapshots.
    for (const sql of [
      `SELECT 1 FROM connector_observations WHERE tenant_id=$1
      AND document->'observation'->'data' ? 'addresses'`,
      `SELECT 1 FROM orders_snapshots WHERE tenant_id=$1 AND document->'data' ? 'addresses'`,
    ])
      expect((await owner.query(sql, [tenant])).rowCount).toBe(0);
    const id = (number: string) =>
      canonical(shop, 'order', `gid://shopify/Order/${number}`);
    const addresses = async (orderId: string, reader = context()) =>
      (await workspace().get(reader, orderId))?.sources[0]?.addresses;
    expect(await addresses(await id('1'), context('viewer'))).toEqual({
      state: 'shared',
      shipping: home,
      billing: null,
      observedAt: expect.any(String),
    });
    expect(await addresses(await id('3'))).toEqual({
      state: 'not_shared',
      observedAt: expect.any(String),
    });
    expect(await addresses(await canonical(erp, 'order', '9'))).toEqual({
      state: 'not_imported',
    });

    // Without permission to read customers, addresses are hidden, never empty.
    const ordersOnly = makeTenantContext(
      { userId: 'viewer', sessionId: 'session' },
      {
        id: tenant,
        name: 'Fixture',
        slug: 'fixture',
        status: 'active',
        dataRegion: 'AU',
      },
      {
        ...builtInMembership(
          { id: 'm-viewer', organizationId: tenant, userId: 'viewer' },
          'member',
        ),
        permissions: new PermissionSet(['orders.read']),
      },
      randomUUID(),
    );
    const restricted = await workspace().get(ordersOnly, await id('1'));
    expect(restricted?.hidden).toContain('addresses');
    expect(restricted?.sources[0]).not.toHaveProperty('addresses');

    // An older read does not replace newer addresses.
    const profiles = createCustomerProfiles(db);
    await profiles.recordOrderAddresses(context(), shop, [
      {
        order: { externalId: 'gid://shopify/Order/2', scopeKey: '' },
        shared: true,
        shipping: null,
        billing: null,
        observedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(await addresses(await id('2'))).toMatchObject({ shipping: home });

    const stored = async () =>
      (
        await owner.query<{ order_external_id: string }>(
          'SELECT order_external_id FROM customer_order_addresses WHERE tenant_id=$1 ORDER BY 1',
          [tenant],
        )
      ).rows.map((row) => row.order_external_id);
    await owner.query(
      'INSERT INTO shopify_installation_bindings(tenant_id,app,shop,connection_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [tenant, 'test:app', 'fixture.myshopify.com', shop],
    );
    // A redaction that lists only orders erases their addresses and no customer.
    await runtime.query('SELECT erase_shopify_customer_data($1,$2,$3,$4)', [
      'test:app',
      'fixture.myshopify.com',
      [],
      ['gid://shopify/Order/2'],
    ]);
    expect(await stored()).toEqual([
      'gid://shopify/Order/1',
      'gid://shopify/Order/3',
    ]);
    expect(
      (
        await owner.query(
          'SELECT 1 FROM customer_profiles WHERE tenant_id=$1',
          [tenant],
        )
      ).rowCount,
    ).toBe(0);
    // Erasing a customer erases the addresses of the orders they placed.
    await profiles.erase(context(), shop, [ada]);
    expect(await stored()).toEqual(['gid://shopify/Order/3']);

    // Newer reads of erased orders do not store their addresses again.
    source.set(shop, 'orders.read', orders(new Date().toISOString()));
    await service.command(context(), (await stream('orders'))!.id, 'reimport');
    await drain();
    expect(await stored()).toEqual(['gid://shopify/Order/3']);
    expect(await addresses(await id('1'))).toEqual({ state: 'not_imported' });

    // Shop redaction erases every address of the shop.
    await runtime.query('SELECT erase_shopify_customer_data($1,$2,$3)', [
      'test:app',
      'fixture.myshopify.com',
      null,
    ]);
    expect(await stored()).toEqual([]);
  });

  it('flags customers the source no longer has and removes them only after they stay missing', async () => {
    const all = ['501', '502', '503', '504'];
    source.set(
      erp,
      'customers.read',
      all.map((id) => customer(erp, id)),
    );
    source.set(erp, 'orders.read', [order(erp, '9', { customer: '501' })]);
    await drain();
    const customers = createCustomerWorkspace(db);
    const missing = async () =>
      Object.fromEntries(
        (
          await customers.list(context(), {
            q: '',
            sort: 'name',
            direction: 'asc',
            limit: 50,
          })
        ).items.map((item) => [item.externalId, item.missingSince]),
      );
    const reconcile = async () => {
      await service.command(
        context(),
        (await stream('customers', erp))!.id,
        'reconcile',
      );
      await drain();
    };
    expect(await missing()).toEqual({
      '501': null,
      '502': null,
      '503': null,
      '504': null,
    });

    // One complete read without a customer only flags them; profile and order link stay.
    source.set(
      erp,
      'customers.read',
      all.slice(1).map((id) => customer(erp, id)),
    );
    await reconcile();
    expect((await missing())['501']).not.toBeNull();
    const links = async () =>
      (
        await owner.query<{ customer_external_id: string }>(
          'SELECT customer_external_id FROM customer_orders WHERE tenant_id=$1',
          [tenant],
        )
      ).rows.map((row) => row.customer_external_id);
    expect(await links()).toEqual(['501']);

    // After the retention period the next full read removes the customer. A customer flagged as
    // long but found again in that read stays.
    await owner.query(
      `UPDATE commerce_sync_items SET missing_since=now()-interval '31 days'
      WHERE tenant_id=$1 AND record_type='customers' AND external_id IN ('501','502')`,
      [tenant],
    );
    await reconcile();
    expect(await missing()).toEqual({ '502': null, '503': null, '504': null });
    expect(await links()).toEqual([]);
    const ledger = await owner.query(
      "SELECT 1 FROM commerce_sync_items WHERE tenant_id=$1 AND record_type='customers' AND external_id='501'",
      [tenant],
    );
    expect(ledger.rowCount).toBe(0);

    // Removal is not an erasure: a customer the source reports again is imported again.
    source.set(
      erp,
      'customers.read',
      all.map((id) => customer(erp, id)),
    );
    await reconcile();
    expect(await missing()).toEqual({
      '501': null,
      '502': null,
      '503': null,
      '504': null,
    });
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

  async function autoDue() {
    await owner.query(
      'UPDATE commerce_auto_link_rules SET due_at=now() WHERE tenant_id=$1',
      [tenant],
    );
  }

  const autoPair = (kind: 'sku' | 'order') => ({
    kind,
    targetConnectionId: shop,
    sourceConnectionId: erp,
  });

  it('automatically links unique SKUs and explicit order references, replays related records and respects manual separation', async () => {
    source.set(shop, 'products.read', [product(shop, 'p1', 'item-1', 'ABC-1')]);
    source.set(erp, 'products.read', [product(erp, 'p9', 'item-9', ' abc-1 ')]);
    source.set(shop, 'orders.read', [order(shop, '1')]);
    source.set(erp, 'orders.read', [
      order(erp, '9', { sku: 'item-9', number: 'SO-9', externalNumber: '#1' }),
    ]);
    source.set(erp, 'fulfillment.read', [shipment(erp, 'f9', '9')]);
    source.set(shop, 'inventory.read', [stock(shop, 'item-1', '3')]);
    source.set(erp, 'inventory.read', [stock(erp, 'item-9', '8')]);
    await drain();
    const shopSku = await canonical(shop, 'sku', 'item-1');
    const erpSku = await canonical(erp, 'sku', 'item-9');
    const shopOrder = await canonical(shop, 'order', '1');
    const erpOrder = await canonical(erp, 'order', '9');
    expect(shopSku).not.toBe(erpSku);
    expect(shopOrder).not.toBe(erpOrder);
    for (const kind of ['sku', 'order'] as const) {
      expect(
        await service.previewAutoLinks(context(), autoPair(kind)),
      ).toMatchObject({ ready: true, counts: { eligible: 1 } });
      await service.saveAutoLinkRule(context(), {
        ...autoPair(kind),
        id: randomUUID(),
        revision: 0,
        enabled: true,
      });
    }
    expect(await runner.scopes()).toContain(tenant);
    await Promise.all([runner.tick(tenant, 0), runner.tick(tenant, 0)]);
    expect(await canonical(erp, 'sku', 'item-9')).toBe(shopSku);
    expect(await canonical(erp, 'order', '9')).toBe(shopOrder);
    const detail = await workspace().get(context(), shopOrder);
    expect(detail?.sources).toHaveLength(2);
    expect(
      (await services.orders.current(context(), shopOrder)).every(
        (item) =>
          item.snapshot.data.type === 'order' &&
          item.snapshot.data.lines.every((line) => line.skuId === shopSku),
      ),
    ).toBe(true);
    const evidence = await owner.query<{ method: string; reason: string }>(
      "SELECT method,reason FROM connector_mapping_revisions WHERE tenant_id=$1 AND resource IN ('sku','order')",
      [tenant],
    );
    expect(evidence.rows).toHaveLength(2);
    expect(
      evidence.rows.every(
        (item) =>
          item.method.startsWith('Automatically linked by rule') &&
          item.reason.includes('revision 1'),
      ),
    ).toBe(true);
    expect(
      (await service.autoLinkRules(context())).map((rule) => rule.linked),
    ).toEqual([1, 1]);
    await autoDue();
    await runner.tick(tenant, 0);
    expect(
      (await service.autoLinkRules(context())).map((rule) => rule.linked),
    ).toEqual([1, 1]);
    await service.requestLink(context(), {
      kind: 'sku',
      operation: 'unlink',
      entityId: shopSku,
      connectionId: erp,
      reason: 'Different item',
    });
    await service.requestLink(context(), {
      kind: 'order',
      operation: 'unlink',
      entityId: shopOrder,
      connectionId: erp,
      reason: 'Different order',
    });
    await autoDue();
    await runner.tick(tenant, 0);
    expect(await canonical(erp, 'sku', 'item-9')).toBe(erpSku);
    expect(await canonical(erp, 'order', '9')).toBe(erpOrder);
    for (const kind of ['sku', 'order'] as const)
      expect(
        await service.previewAutoLinks(context(), autoPair(kind)),
      ).toMatchObject({ counts: { eligible: 0, excluded: 1 } });
  });

  it('previews ambiguities and missing evidence without choosing an arbitrary SKU or order', async () => {
    source.set(shop, 'products.read', [
      product(shop, 'p1', 'item-1', 'DUP'),
      product(shop, 'p2', 'item-2', 'DUP'),
    ]);
    source.set(erp, 'products.read', [product(erp, 'p9', 'item-9', 'dup')]);
    source.set(shop, 'orders.read', [
      order(shop, '1'),
      order(shop, '2', { number: '#1' }),
    ]);
    source.set(erp, 'orders.read', [
      order(erp, '9', { externalNumber: '#1' }),
      order(erp, '10', { number: '#2' }),
    ]);
    await drain();
    for (const kind of ['sku', 'order'] as const) {
      expect(
        await service.previewAutoLinks(context(), autoPair(kind)),
      ).toMatchObject({ ready: true, counts: { eligible: 0, ambiguous: 1 } });
      await service.saveAutoLinkRule(context(), {
        ...autoPair(kind),
        id: randomUUID(),
        revision: 0,
        enabled: true,
      });
    }
    await runner.tick(tenant, 0);
    expect(
      (await service.autoLinkRules(context())).every(
        (rule) => rule.linked === 0,
      ),
    ).toBe(true);
    await owner.query(
      "UPDATE commerce_sync_streams SET last_full_scan_at=NULL WHERE tenant_id=$1 AND connection_id=$2 AND record_type='products'",
      [tenant, erp],
    );
    expect(
      await service.previewAutoLinks(context(), autoPair('sku')),
    ).toMatchObject({ ready: false, candidates: [] });
    await owner.query(
      "UPDATE commerce_sync_streams SET last_full_scan_at=now(),last_success_at=now()-interval '2 days' WHERE tenant_id=$1 AND connection_id=$2 AND record_type='products'",
      [tenant, erp],
    );
    expect(
      await service.previewAutoLinks(context(), autoPair('sku')),
    ).toMatchObject({ ready: false });
  });

  it('revalidates candidates after preview and skips stale ledger evidence and incompatible units', async () => {
    source.set(shop, 'products.read', [product(shop, 'p1', 'item-1', 'ABC-1')]);
    source.set(erp, 'products.read', [product(erp, 'p9', 'item-9', 'abc-1')]);
    await drain();
    expect(
      (await service.previewAutoLinks(context(), autoPair('sku'))).counts
        .eligible,
    ).toBe(1);
    const rule = await service.saveAutoLinkRule(context(), {
      ...autoPair('sku'),
      id: randomUUID(),
      revision: 0,
      enabled: true,
    });
    // A second SKU arrives after preview, before the rule runs.
    source.set(erp, 'products.read', [
      product(erp, 'p9', 'item-9', 'abc-1'),
      product(erp, 'p10', 'item-10', 'ABC-1'),
    ]);
    await due();
    await drain();
    expect((await service.autoLinkRules(context()))[0]).toMatchObject({
      id: rule.id,
      linked: 0,
    });
    expect(
      (await service.previewAutoLinks(context(), autoPair('sku'))).counts
        .ambiguous,
    ).toBe(1);
    await owner.query(
      "UPDATE inventory_product_skus SET code='OTHER' WHERE tenant_id=$1 AND product_id=(SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='product' AND external_id='p10')",
      [tenant, erp],
    );
    await owner.query(
      "UPDATE inventory_product_skus SET unit='case' WHERE tenant_id=$1 AND connection_id=$2",
      [tenant, erp],
    );
    expect(
      (await service.previewAutoLinks(context(), autoPair('sku'))).counts
        .conflict,
    ).toBe(1);
    await owner.query(
      "UPDATE inventory_product_skus SET unit='each' WHERE tenant_id=$1 AND connection_id=$2",
      [tenant, erp],
    );
    // A recent read of an older provider version cannot refresh the retained projection's identity evidence.
    await owner.query(
      "UPDATE commerce_sync_items SET source_updated_at=source_updated_at-interval '1 day' WHERE tenant_id=$1 AND connection_id=$2 AND record_type='products'",
      [tenant, erp],
    );
    expect(
      (await service.previewAutoLinks(context(), autoPair('sku'))).counts.stale,
    ).toBe(1);
    await owner.query(
      "UPDATE commerce_sync_items SET source_updated_at=source_updated_at+interval '1 day' WHERE tenant_id=$1 AND connection_id=$2 AND record_type='products'",
      [tenant, erp],
    );
    await owner.query(
      "UPDATE commerce_sync_items SET missing_since=now() WHERE tenant_id=$1 AND connection_id=$2 AND record_type='products'",
      [tenant, erp],
    );
    expect(
      (await service.previewAutoLinks(context(), autoPair('sku'))).counts.stale,
    ).toBe(1);
    await autoDue();
    await runner.tick(tenant, 0);
    expect((await service.autoLinkRules(context()))[0]!.linked).toBe(0);
  });

  it('audits revision-checked configuration, disables future linking and blocks revoked authority', async () => {
    source.set(shop, 'products.read', [product(shop, 'p1', 'item-1', 'ABC-1')]);
    source.set(erp, 'products.read', [product(erp, 'p9', 'item-9', 'abc-1')]);
    await drain();
    const input = {
      ...autoPair('sku'),
      id: randomUUID(),
      revision: 0,
      enabled: true,
    };
    await expect(
      service.saveAutoLinkRule(context('viewer'), input),
    ).rejects.toThrow();
    await expect(
      service.previewAutoLinks(context('viewer'), autoPair('sku')),
    ).rejects.toThrow();
    await expect(
      service.saveAutoLinkRule(context(), {
        ...input,
        sourceConnectionId: randomUUID(),
      }),
    ).rejects.toThrow('Connection not found');
    let rule = await service.saveAutoLinkRule(context(), input);
    await expect(service.saveAutoLinkRule(context(), input)).rejects.toThrow(
      'This rule changed',
    );
    await expect(
      service.saveAutoLinkRule(context(), {
        ...input,
        id: randomUUID(),
        targetConnectionId: erp,
        sourceConnectionId: shop,
      }),
    ).rejects.toThrow('A rule already exists');
    rule = await service.saveAutoLinkRule(context(), {
      ...input,
      revision: rule.revision,
      enabled: false,
    });
    await runner.tick(tenant, 0);
    expect((await service.autoLinkRules(context()))[0]).toMatchObject({
      state: 'disabled',
      linked: 0,
    });
    rule = await service.saveAutoLinkRule(context(), {
      ...input,
      revision: rule.revision,
    });
    members.set('operator', 'member');
    try {
      await runner.tick(tenant, 0);
      expect(
        (await createAutomaticLinkStore(db).list(tenant))[0],
      ).toMatchObject({ state: 'blocked', linked: 0 });
    } finally {
      members.set('operator', 'owner');
    }
    await service.saveAutoLinkRule(context(), {
      ...input,
      revision: rule.revision,
    });
    await runner.tick(tenant, 0);
    expect((await service.autoLinkRules(context()))[0]).toMatchObject({
      state: 'active',
      linked: 1,
    });
    expect(
      (
        await owner.query(
          'SELECT count(*) FROM commerce_auto_link_rule_revisions WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].count,
    ).toBe('4');
    expect(await createAutomaticLinkStore(db).list(randomUUID())).toEqual([]);
    await db.transaction(randomUUID(), async (tx) => {
      expect(
        (await tx.query('SELECT * FROM commerce_auto_link_rules')).rows,
      ).toEqual([]);
      expect(
        (await tx.query('SELECT * FROM commerce_auto_link_rule_revisions'))
          .rows,
      ).toEqual([]);
    });
  });

  it('keeps equal order numbers in different Shopify stores separate', async () => {
    source.set(shop, 'orders.read', [order(shop, '1')]);
    source.set(erp, 'orders.read', [order(erp, '9', { externalNumber: '#1' })]);
    await drain();
    await service.saveAutoLinkRule(context(), {
      ...autoPair('order'),
      id: randomUUID(),
      revision: 0,
      enabled: true,
    });
    await runner.tick(tenant, 0);
    const otherShop = randomUUID();
    await owner.query(
      `INSERT INTO connector_installations(tenant_id,id,version,document,secret)
      SELECT tenant_id,$2::uuid,version,jsonb_set(jsonb_set(document,'{id}',to_jsonb(($2::uuid)::text)),'{label}','"Other store"'),secret
      FROM connector_installations WHERE tenant_id=$1 AND id=$3`,
      [tenant, otherShop, shop],
    );
    await owner.query(
      `INSERT INTO connector_lifecycle_events(tenant_id,connection_id,version,event,actor_id,status,credential_version)
      VALUES($1,$2,1,'installed','operator','active',1)`,
      [tenant, otherShop],
    );
    for (const capability of reads) source.set(otherShop, capability, []);
    source.set(otherShop, 'orders.read', [order(otherShop, '1')]);
    await drain();
    const pair = {
      kind: 'order' as const,
      targetConnectionId: otherShop,
      sourceConnectionId: erp,
    };
    expect(await service.previewAutoLinks(context(), pair)).toMatchObject({
      ready: true,
      counts: { eligible: 0, conflict: 1 },
    });
    await service.saveAutoLinkRule(context(), {
      ...pair,
      id: randomUUID(),
      revision: 0,
      enabled: true,
    });
    await runner.tick(tenant, 0);
    expect(await canonical(erp, 'order', '9')).toBe(
      await canonical(shop, 'order', '1'),
    );
    expect(await canonical(otherShop, 'order', '1')).not.toBe(
      await canonical(shop, 'order', '1'),
    );
  });

  it('rolls back mapping changes and replay after interruption, then resumes without duplicating links', async () => {
    source.set(shop, 'products.read', [product(shop, 'p1', 'item-1', 'ABC-1')]);
    source.set(erp, 'products.read', [product(erp, 'p9', 'item-9', 'abc-1')]);
    await drain();
    const shopSku = await canonical(shop, 'sku', 'item-1');
    const erpSku = await canonical(erp, 'sku', 'item-9');
    const rule = await service.saveAutoLinkRule(context(), {
      ...autoPair('sku'),
      id: randomUUID(),
      revision: 0,
      enabled: true,
    });
    const interrupted = createAutoLinkStore(
      db,
      async (scoped, actor, value, candidate) => {
        await createCommerceServices(scoped).ingestion.link(
          actor,
          value.kind,
          candidate.targetId,
          candidate.sourceId,
          'Interrupted automatic match',
        );
        throw new Error('Interrupted after remap');
      },
    );
    await expect(interrupted.apply(context(), rule.id)).rejects.toThrow(
      'Interrupted after remap',
    );
    expect(await canonical(erp, 'sku', 'item-9')).toBe(erpSku);
    expect((await service.autoLinkRules(context()))[0]!.linked).toBe(0);
    expect(
      (
        await owner.query(
          'SELECT count(*) FROM connector_mapping_revisions WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].count,
    ).toBe('0');
    await runner.tick(tenant, 0);
    expect(await canonical(erp, 'sku', 'item-9')).toBe(shopSku);
    expect((await service.autoLinkRules(context()))[0]!.linked).toBe(1);
  });

  it('applies large candidate sets in bounded restartable batches', async () => {
    for (const connectionId of [shop, erp])
      source.set(
        connectionId,
        'products.read',
        Array.from({ length: 21 }, (_, index) =>
          product(connectionId, `p${index}`, `s${index}`, `BATCH-${index}`),
        ),
      );
    await drain();
    const rule = await service.saveAutoLinkRule(context(), {
      ...autoPair('sku'),
      id: randomUUID(),
      revision: 0,
      enabled: true,
    });
    const store = createAutomaticLinkStore(db);
    expect(
      (await service.previewAutoLinks(context(), autoPair('sku'))).counts
        .eligible,
    ).toBe(21);
    await store.apply(context(), rule.id);
    expect((await service.autoLinkRules(context()))[0]!.linked).toBe(20);
    expect(await store.scopes()).toContain(tenant);
    await createAutomaticLinkStore(db).apply(context(), rule.id);
    expect((await service.autoLinkRules(context()))[0]!.linked).toBe(21);
    expect(
      (await service.previewAutoLinks(context(), autoPair('sku'))).counts
        .eligible,
    ).toBe(0);
  });

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
      (db) =>
        createSourceAuthority(
          db,
          (provider) =>
            provider === 'jtl'
              ? 'erp'
              : provider === 'shopify'
                ? 'storefront'
                : null,
          async (value) => value,
        ),
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
      { asOf: new Date().toISOString(), scope: {}, limit: 50 },
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

  it('pauses while the workspace is suspended without blocking or failing its streams', async () => {
    source.set(shop, 'orders.read', [order(shop, '1')]);
    await owner.query(
      "UPDATE organizations SET status='suspended' WHERE id=$1",
      [tenant],
    );
    try {
      expect(await runner.scopes()).not.toContain(tenant);
      // A pass that began before the suspension stops at the rejected context.
      workspaceStatus = 'suspended';
      await runner.tick(tenant, 5000);
      expect(await stream('orders')).toMatchObject({
        blocked: null,
        attempts: 0,
        error_code: null,
        phase: 'backfill',
      });
    } finally {
      workspaceStatus = 'active';
      await owner.query(
        "UPDATE organizations SET status='active' WHERE id=$1",
        [tenant],
      );
    }
    // The paused page's lease expires; the stream then continues where it was.
    await owner.query(
      'UPDATE commerce_sync_streams SET lease_until=now() WHERE tenant_id=$1',
      [tenant],
    );
    await drain();
    expect(await stream('orders')).toMatchObject({
      blocked: null,
      phase: 'incremental',
      error_code: null,
    });
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
                "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
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
