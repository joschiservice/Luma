import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import {
  createAdaptiveViewReadAdapter,
  createAdaptiveViews,
} from '@luma/adaptive/composition';
import {
  adaptiveViewQueryV1Schema,
  orderListQuerySchema,
} from '@luma/api-contract';
import { buildApp, createCommerceServices } from '@luma/application-runtime';
import {
  assistantModelProfile,
  createWorkspaceAssistant,
} from '@luma/assistant/composition';
import type { CommerceObservation } from '@luma/connections';
import {
  createConnectionCoverage,
  createOrderReadChecks,
  createSourceAuthority,
} from '@luma/connections/composition';
import {
  orderAttentionForOrders,
  orderAttentionQuery,
} from '@luma/exceptions/composition';
import { type IdentityService, PermissionSet } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import {
  createOrderListRebuilder,
  createOrderMetricReader,
  orderStateQueries,
} from '@luma/orders/composition';
import type { ModelAdapter } from '@luma/platform';
import {
  createModelGateway,
  createObservability,
  createTenantDatabase,
} from '@luma/platform/composition';
import {
  createCustomerWorkspace,
  createOperationalMetrics,
  createOrderWorkspace,
  createSourceOrderLines,
} from '@luma/read-models/composition';
import { createActivityStore } from '@luma/resolution/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

type OrderData = Extract<
  CommerceObservation,
  { capability: 'orders.read' }
>['observation']['data'];

describe.skipIf(!databaseUrl)('Orders workspace on PostgreSQL', () => {
  const name = `orders_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  let owner: Pool,
    writer: Pool,
    reader: Pool,
    services: ReturnType<typeof createCommerceServices>;
  const tenant = randomUUID(),
    otherTenant = randomUUID(),
    shopify = randomUUID(),
    jtl = randomUUID(),
    foreign = randomUUID();
  let clock = new Date('2026-09-20T12:00:00Z');

  function context(tenantId: string = tenant) {
    return makeTenantContext(
      { userId: 'operator', sessionId: 'session' },
      {
        id: tenantId,
        name: 'Fixture',
        slug: 'fixture',
        status: 'active',
        dataRegion: 'AU',
      },
      builtInMembership(
        { id: 'membership', organizationId: tenantId, userId: 'operator' },
        'owner',
      ),
      randomUUID(),
    );
  }

  function workspace(
    actionPermission?: (appId: string, capability: string) => string | null,
  ) {
    return createOrderWorkspace(
      createTenantDatabase(reader),
      {
        state: orderStateQueries,
        attention: orderAttentionQuery,
        attentionFor: orderAttentionForOrders,
      },
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
      () => clock,
      undefined,
      actionPermission,
    );
  }

  /** Ingests one order observation and binds its identities with explicit keys. */
  async function seedOrder(options: {
    tenantId?: string;
    connectionId: string;
    external: string;
    key: string;
    updatedAt: string;
    data: Partial<OrderData>;
    lines: {
      external: string;
      key: string;
      quantity: string;
      cancelled?: string | null;
      current?: string | null;
      sku?: { external: string; key: string } | null;
      skuCode?: string | null;
      title?: string | null;
      unitPrice?: string;
    }[];
  }) {
    const tenantId = options.tenantId ?? tenant;
    const source = {
      tenantId,
      connectionId: options.connectionId,
      provider: options.connectionId === jtl ? 'jtl' : 'shopify',
      resource: 'order' as const,
      externalId: options.external,
      scopeKey: '',
    };
    const observation: CommerceObservation & { capability: 'orders.read' } = {
      capability: 'orders.read',
      observation: {
        id: randomUUID(),
        source,
        kind: 'snapshot',
        observedAt: options.updatedAt,
        sourceUpdatedAt: options.updatedAt,
        sourceRevision: null,
        adapterVersion: 'fixture/1',
        schemaVersion: 1,
        data: {
          displayNumber: null,
          status: 'open',
          paymentStatus: 'paid',
          ...options.data,
          lines: options.lines.map((line) => ({
            id: { externalId: line.external, scopeKey: options.external },
            sku: line.sku
              ? { externalId: line.sku.external, scopeKey: '' }
              : null,
            quantity: { amount: line.quantity, unit: 'each' },
            ...(line.current === undefined
              ? {}
              : {
                  currentQuantity:
                    line.current === null
                      ? null
                      : { amount: line.current, unit: 'each' },
                }),
            cancelledQuantity:
              line.cancelled === null
                ? null
                : { amount: line.cancelled ?? '0', unit: 'each' },
            skuCode: line.skuCode ?? null,
            title: line.title ?? null,
            ...(line.unitPrice
              ? { unitPrice: { amount: line.unitPrice, currency: 'EUR' } }
              : {}),
          })),
        },
      },
    };
    const actor = context(tenantId);
    const key = observation.observation.id;
    const ingested = await services.ingestion.ingest(actor, key, observation);
    const orderId = await services.ingestion.bind(
      actor,
      source,
      options.key,
      observation.observation.id,
      'operator-confirmed',
    );
    for (const line of options.lines) {
      await services.ingestion.bind(
        actor,
        {
          ...source,
          resource: 'order_line',
          externalId: line.external,
          scopeKey: options.external,
        },
        line.key,
        observation.observation.id,
        'operator-confirmed',
      );
      if (line.sku)
        await services.ingestion.bind(
          actor,
          {
            ...source,
            resource: 'sku',
            externalId: line.sku.external,
            scopeKey: '',
          },
          line.sku.key,
          observation.observation.id,
          'operator-confirmed',
        );
    }
    const result =
      ingested.status === 'applied'
        ? ingested
        : await services.ingestion.replay(actor, options.connectionId, key);
    expect(result.status).toBe('applied');

    return orderId;
  }

  async function seedShipment(options: {
    connectionId: string;
    order: string;
    external: string;
    line: string;
    quantity: string;
    status: 'shipped' | 'processing' | 'completed';
    kind?: 'fulfillment_order' | 'shipment';
    remaining?: string;
    observedAt?: string;
    holds?: { reason: 'inventory_out_of_stock' }[];
    location?: { id: { externalId: string; scopeKey: string }; name: string };
  }) {
    const observation: CommerceObservation & {
      capability: 'fulfillment.read';
    } = {
      capability: 'fulfillment.read',
      observation: {
        id: randomUUID(),
        source: {
          tenantId: tenant,
          connectionId: options.connectionId,
          provider: options.connectionId === jtl ? 'jtl' : 'shopify',
          resource: 'fulfillment',
          externalId: options.external,
          scopeKey: '',
        },
        kind: 'snapshot',
        observedAt: options.observedAt ?? '2026-09-19T10:00:00Z',
        sourceUpdatedAt: options.observedAt ?? '2026-09-19T10:00:00Z',
        sourceRevision: null,
        adapterVersion: 'fixture/1',
        schemaVersion: 1,
        data: {
          order: { externalId: options.order, scopeKey: '' },
          status: options.status,
          ...(options.holds ? { holds: options.holds } : {}),
          ...(options.location ? { location: options.location } : {}),
          ...(options.kind ? { kind: options.kind } : {}),
          lastProgressAt: '2026-09-19T10:00:00Z',
          failureCode: null,
          lines: [
            {
              orderLine: { externalId: options.line, scopeKey: options.order },
              quantity: { amount: options.quantity, unit: 'each' },
              ...(options.remaining === undefined
                ? {}
                : {
                    remainingQuantity: {
                      amount: options.remaining,
                      unit: 'each',
                    },
                  }),
            },
          ],
        },
      },
    };
    const key = observation.observation.id;
    await services.ingestion.ingest(context(), key, observation);
    const id = await services.ingestion.bind(
      context(),
      observation.observation.source,
      options.external,
      observation.observation.id,
      'operator-confirmed',
    );
    if (options.location)
      await services.ingestion.bind(
        context(),
        {
          ...observation.observation.source,
          resource: 'location',
          externalId: options.location.id.externalId,
          scopeKey: options.location.id.scopeKey,
        },
        options.location.name,
        observation.observation.id,
        'operator-confirmed',
      );
    await services.ingestion.replay(context(), options.connectionId, key);

    return id;
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
    const password = randomUUID();
    // The writer mirrors the ingestion worker; the reader mirrors the API login.
    for (const [role, grants] of [
      [`${name}_w`, 'luma_connectors,luma_orders,luma_inventory'],
      [
        `${name}_r`,
        'luma_connectors,luma_case_reader,luma_desk,luma_adaptive,luma_commerce_sync',
      ],
    ] as const) {
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(`GRANT ${grants} TO "${role}"`);
    }
    url.password = password;
    url.username = `${name}_w`;
    services = createCommerceServices(url.toString());
    writer = new Pool({ connectionString: url.toString() });
    url.username = `${name}_r`;
    reader = new Pool({ connectionString: url.toString() });
    for (const [tenantId, id, kind, label] of [
      [tenant, shopify, 'shopify', 'Shopify store'],
      [tenant, jtl, 'jtl', 'JTL-Wawi'],
      [otherTenant, foreign, 'shopify', 'Other store'],
    ]) {
      await owner.query(
        "INSERT INTO workspace_apps(tenant_id,app_id,status,version) VALUES($1,$2,'installed',1) ON CONFLICT DO NOTHING",
        [tenantId, kind],
      );
      await owner.query(
        'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
        [
          tenantId,
          id,
          {
            id,
            tenantId,
            version: 1,
            status: 'active',
            appId: kind,
            appInstallationVersion: 1,
            target: { kind },
            label,
            permissions: ['orders.read', 'fulfillment.read', 'inventory.read'],
            granted: ['orders.read', 'fulfillment.read', 'inventory.read'],
          },
          'encrypted-fixture',
        ],
      );
    }
  });

  afterAll(async () => {
    await services?.close();
    await reader?.end();
    await writer?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE IF EXISTS "${name}_w"`);
    await admin.query(`DROP ROLE IF EXISTS "${name}_r"`);
    await admin.end();
  });

  beforeEach(async () => {
    clock = new Date('2026-09-20T12:00:00Z');
    await owner.query(
      'TRUNCATE connector_authority_settings,connector_authority_events,connector_observations,connector_order_read_checks,connector_source_mappings,orders_entities,inventory_entities,exceptions,playbook_definitions CASCADE',
    );
  });

  it('resolves order fact groups independently and audits overrides without rewriting source evidence', async () => {
    const id = await seedOrder({
      connectionId: shopify,
      external: 'shop-order',
      key: 'authority-order',
      updatedAt: '2026-09-19T10:00:00Z',
      data: {},
      lines: [
        {
          external: 'shop-line',
          key: 'shop-line',
          quantity: '2',
          current: '1',
        },
      ],
    });
    await seedOrder({
      connectionId: jtl,
      external: 'erp-order',
      key: 'authority-order',
      updatedAt: '2026-09-20T10:00:00Z',
      data: { status: 'completed' },
      lines: [{ external: 'erp-line', key: 'erp-line', quantity: '7' }],
    });
    await seedShipment({
      connectionId: jtl,
      order: 'erp-order',
      external: 'shipment',
      line: 'erp-line',
      quantity: '7',
      status: 'shipped',
    });
    const settings = createSourceAuthority(
      createTenantDatabase(reader),
      (provider) => (provider === 'jtl' ? 'erp' : 'storefront'),
      async (value) => value,
    );
    const initial = (await workspace().get(context(), id))!;
    expect(initial.authority.lines).toMatchObject({
      connectionId: shopify,
      lines: [{ quantity: '2', currentQuantity: '1' }],
    });
    expect(initial.authority.lifecycle).toMatchObject({
      connectionId: shopify,
      status: 'open',
    });
    expect(initial.authority.fulfillments).toMatchObject([
      { connectionId: jtl, status: 'shipped' },
    ]);
    const before = (
      await owner.query(
        'SELECT id,document FROM orders_snapshots WHERE tenant_id=$1 ORDER BY id',
        [tenant],
      )
    ).rows;
    const command = {
      commandId: randomUUID(),
      revision: 0,
      group: 'order_lines' as const,
      connectionId: jtl,
    };
    const event = await settings.change(context(), command);
    expect(event).toMatchObject({
      actorId: 'operator',
      previousConnectionId: null,
      connectionId: jtl,
      revision: 1,
    });
    const changed = (await workspace().get(context(), id))!;
    expect(changed.authority.lines).toMatchObject({
      connectionId: jtl,
      lines: [{ quantity: '7', currentQuantity: null }],
    });
    expect(changed.authority.fulfillments).toMatchObject([
      { connectionId: jtl, status: 'shipped' },
    ]);
    expect(changed.sources).toEqual(initial.sources);
    expect(
      (
        await owner.query(
          'SELECT id,document FROM orders_snapshots WHERE tenant_id=$1 ORDER BY id',
          [tenant],
        )
      ).rows,
    ).toEqual(before);
    expect(await settings.change(context(), command)).toEqual(event);
    expect(await settings.history(context())).toEqual([event]);
    await expect(
      settings.change(context(), { ...command, commandId: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      settings.change(context(), { ...command, group: 'order_lifecycle' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      settings.change(context(), {
        ...command,
        commandId: randomUUID(),
        revision: 1,
        connectionId: foreign,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await settings.history(context(otherTenant))).toEqual([]);
    const concurrent = await Promise.allSettled([
      settings.change(context(), {
        ...command,
        revision: 1,
        commandId: randomUUID(),
        connectionId: null,
      }),
      settings.change(context(), {
        ...command,
        revision: 1,
        commandId: randomUUID(),
        connectionId: shopify,
      }),
    ]);
    expect(
      concurrent.filter((item) => item.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(await settings.history(context())).toHaveLength(2);
    await createTenantDatabase(reader).transaction(tenant, async (tx) => {
      await expect(
        tx.query(
          'UPDATE connector_authority_events SET revision=99 WHERE tenant_id=$1',
          [tenant],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  async function seedWorkspace() {
    const tote = { external: 'gid://shopify/InventoryItem/31', key: 'tote' };
    const a = await seedOrder({
      connectionId: shopify,
      external: 'gid://shopify/Order/1001',
      key: 'order-a',
      updatedAt: '2026-09-18T09:00:00Z',
      data: {
        displayNumber: '#1001',
        placedAt: '2026-09-10T08:00:00Z',
        total: { amount: '48.00', currency: 'EUR' },
      },
      lines: [
        {
          external: 'gid://shopify/LineItem/11',
          key: 'order-a-line',
          quantity: '2',
          sku: tote,
          skuCode: 'TOTE-RED',
          title: 'Canvas tote',
        },
      ],
    });
    // The same order observed in the ERP later, with its own number and a pending payment.
    const mirrored = await seedOrder({
      connectionId: jtl,
      external: 'jtl-order-10',
      key: 'order-a',
      updatedAt: '2026-09-19T09:00:00Z',
      data: {
        displayNumber: 'SO-10',
        paymentStatus: 'pending',
        placedAt: '2026-09-10T08:05:00Z',
        total: { amount: '48', currency: 'EUR' },
      },
      lines: [
        {
          external: '101',
          key: 'order-a-line-jtl',
          quantity: '2',
          sku: { external: 'jtl-item-77', key: 'tote' },
          skuCode: 'TOTE-RED',
        },
      ],
    });
    const b = await seedOrder({
      connectionId: shopify,
      external: 'gid://shopify/Order/1002',
      key: 'order-b',
      updatedAt: '2026-09-17T09:00:00Z',
      data: {
        displayNumber: '#1002',
        status: 'completed',
        placedAt: '2026-09-11T08:00:00Z',
      },
      lines: [
        {
          external: 'gid://shopify/LineItem/12',
          key: 'order-b-line',
          quantity: '1',
          skuCode: 'MUG-BLUE',
        },
      ],
    });
    const c = await seedOrder({
      connectionId: shopify,
      external: 'gid://shopify/Order/1003',
      key: 'order-c',
      updatedAt: '2026-09-16T09:00:00Z',
      data: {
        displayNumber: '#1003',
        dueAt: '2026-09-19T00:00:00Z',
        placedAt: '2026-09-12T08:00:00Z',
      },
      lines: [
        {
          external: 'gid://shopify/LineItem/13',
          key: 'order-c-line',
          quantity: '4',
          cancelled: '1',
        },
      ],
    });
    const shipment = await seedShipment({
      connectionId: shopify,
      order: 'gid://shopify/Order/1001',
      external: 'gid://shopify/Fulfillment/51',
      line: 'gid://shopify/LineItem/11',
      quantity: '1',
      status: 'shipped',
    });
    const foreignOrder = await seedOrder({
      tenantId: otherTenant,
      connectionId: foreign,
      external: 'gid://shopify/Order/1001',
      key: 'order-a',
      updatedAt: '2026-09-18T09:00:00Z',
      data: { displayNumber: '#1001' },
      lines: [{ external: 'line', key: 'line', quantity: '1' }],
    });
    const issueId = randomUUID();
    await owner.query(
      `INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,'escalated',$4)`,
      [
        issueId,
        tenant,
        'f'.repeat(64),
        {
          id: issueId,
          tenantId: tenant,
          fingerprint: 'f'.repeat(64),
          state: 'escalated',
          exceptionClass: 'stuck_fulfillment',
          severity: 'high',
          occurrenceCount: 1,
          subject: {
            ruleIdentity: 'fulfillment-progress',
            subjectKind: 'fulfillment',
            subjectId: 'gid://shopify/Fulfillment/51',
            scope: [shopify],
          },
          firstDetectedAt: '2026-09-19T11:00:00Z',
          lastDetectedAt: '2026-09-19T11:00:00Z',
        },
      ],
    );
    await owner.query(
      'INSERT INTO exception_outbox(id,tenant_id,exception_id,document,created_at) VALUES($1,$2,$3,$4,$5)',
      [
        randomUUID(),
        tenant,
        issueId,
        { type: 'exception.detected', occurredAt: '2026-09-19T11:00:00Z' },
        '2026-09-19T11:00:00Z',
      ],
    );

    return { a, mirrored, b, c, shipment, foreignOrder, issueId };
  }

  it('searches, filters, sorts and pages orders within one tenant', async () => {
    const { a, mirrored, b, c, foreignOrder } = await seedWorkspace();
    expect(mirrored).toBe(a);
    const orders = workspace();
    const list = (query: Partial<Parameters<typeof orders.list>[1]> = {}) =>
      orders.list(context(), {
        q: '',
        count: 'exact',
        view: 'all',
        sort: 'updated',
        direction: 'desc',
        limit: 50,
        ...query,
      });
    const ids = async (query: Parameters<typeof list>[0]) =>
      (await list(query)).items.map((item) => item.id);

    const all = await list();
    expect(all.totalCount).toBe(3);
    expect(all.items.map((item) => item.id)).toEqual([a, b, c]);
    const first = all.items[0]!;
    expect(first).toMatchObject({
      displayNumber: 'SO-10',
      paymentStatus: 'pending',
      placedAt: '2026-09-10T08:05:00.000Z',
      total: { amount: '48', currency: 'EUR' },
      fulfillment: 'unfulfilled',
      open: true,
      overdue: null,
      differs: false,
      comparisonState: 'inconclusive',
      lineCount: 1,
    });
    expect(first.issueIds).toHaveLength(1);
    expect(
      first.sources.map((source) => [source.connectionId, source.selected]),
    ).toEqual(
      expect.arrayContaining([
        [shopify, false],
        [jtl, true],
      ]),
    );
    expect(
      first.sources.find((source) => source.connectionId === shopify),
    ).toMatchObject({
      externalId: 'gid://shopify/Order/1001',
      label: 'Shopify store',
    });

    // Numbers, source IDs, SKU text and source SKU IDs all find the same order.
    for (const q of [
      '1001',
      'so-10',
      'jtl-order-10',
      'tote-red',
      'jtl-item-77',
      a,
    ])
      expect(await ids({ q }), q).toEqual([a]);
    expect(await ids({ q: 'MUG' })).toEqual([b]);
    expect(await ids({ q: '100%' })).toEqual([]);

    expect(await ids({ status: 'completed' })).toEqual([b]);
    expect(await ids({ paymentStatus: 'pending' })).toEqual([a]);
    expect(await ids({ connectionId: jtl })).toEqual([a]);
    const scoped = (await list({ connectionId: shopify })).items[0]!;
    expect(scoped).toMatchObject({
      id: a,
      paymentStatus: 'paid',
      fulfillment: 'partial',
    });
    expect(
      await ids({
        placedFrom: '2026-09-11T00:00:00Z',
        placedBefore: '2026-09-12T00:00:00Z',
      }),
    ).toEqual([b]);
    expect(await ids({ updatedFrom: '2026-09-18T00:00:00Z' })).toEqual([a]);

    expect(await ids({ view: 'outstanding' })).toEqual([a, c]);
    expect(await ids({ view: 'overdue' })).toEqual([c]);
    expect(await ids({ view: 'needs_you' })).toEqual([a]);
    expect(await ids({ view: 'differs' })).toEqual([]);

    // The views count exactly the orders behind the shared order metrics.
    const metrics = createOperationalMetrics(
      createTenantDatabase(reader),
      {
        orders: (db) => createOrderMetricReader(db, orderAttentionQuery),
        coverage: createConnectionCoverage,
      },
      () => clock,
    );
    const counts = (await metrics(context(), {})).metrics.map(
      (metric) => metric.observedCount,
    );
    expect(counts).toEqual([
      (await list({ view: 'outstanding' })).totalCount,
      (await list({ view: 'overdue' })).totalCount,
      (await list({ view: 'needs_you' })).totalCount,
    ]);

    expect(await ids({ sort: 'number', direction: 'asc' })).toEqual([b, c, a]);
    expect(await ids({ sort: 'placed', direction: 'asc' })).toEqual([a, b, c]);
    // Orders without a deadline sort last in both directions.
    expect((await ids({ sort: 'due', direction: 'desc' }))[0]).toBe(c);
    expect((await ids({ sort: 'due', direction: 'asc' }))[0]).toBe(c);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({
        sort: 'placed',
        direction: 'desc',
        limit: 1,
        cursor,
      });
      expect(page.totalCount).toBe(3);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([c, b, a]);
    const firstPage = await list({ limit: 1 });
    await expect(
      list({ limit: 1, view: 'overdue', cursor: firstPage.nextCursor! }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const isolated = await orders.list(context(otherTenant), {
      q: '1001',
      view: 'all',
      sort: 'updated',
      direction: 'desc',
      limit: 50,
    });
    expect(isolated.items.map((item) => item.id)).toEqual([foreignOrder]);
    expect(await orders.get(context(otherTenant), a)).toBeNull();
  }, 60000);

  it('filters and groups orders by projected commercial facts', async () => {
    const { a, b, c } = await seedWorkspace();
    const tagged = await seedOrder({
      connectionId: shopify,
      external: 'gid://shopify/Order/1009',
      key: 'order-tagged',
      updatedAt: '2026-09-20T09:00:00Z',
      data: {
        displayNumber: '#1009',
        placedAt: '2026-09-12T08:00:00Z',
        total: { amount: '20.00', currency: 'EUR' },
        currencies: { shop: 'EUR', presentment: 'EUR' },
        tags: ['wholesale', 'priority'],
        discounts: [
          {
            index: 0,
            kind: 'code',
            label: 'WELCOME10',
            target: 'line_item',
            allocation: 'across',
            value: null,
          },
        ],
        shippingLines: [
          {
            id: null,
            title: 'Express',
            code: null,
            source: null,
            carrier: null,
            removed: null,
            original: null,
            discounted: null,
            current: null,
          },
        ],
        attributes: {
          edited: null,
          requiresShipping: true,
          test: true,
          cancelReason: null,
          cancelledAt: null,
          closedAt: null,
          processedAt: null,
          channel: 'Online Store',
          fulfillmentStatus: null,
        },
      },
      lines: [
        {
          external: 'gid://shopify/LineItem/19',
          key: 'order-tagged-line',
          quantity: '1',
          sku: { external: 'gid://shopify/InventoryItem/31', key: 'tote' },
          skuCode: 'TOTE-RED',
        },
      ],
    });
    const orders = workspace();

    type Query = Parameters<typeof orders.list>[1];

    const list = (query: Partial<Query> = {}) =>
      orders.list(context(), {
        q: '',
        view: 'all',
        sort: 'updated',
        direction: 'desc',
        limit: 50,
        ...query,
      });
    const ids = async (conditions: NonNullable<Query['where']>['conditions']) =>
      (await list({ where: { match: 'all', conditions } })).items.map(
        (item) => item.id,
      );

    expect(
      await ids([{ field: 'tags', op: 'any_of', value: ['wholesale'] }]),
    ).toEqual([tagged]);
    expect(
      await ids([
        { field: 'tags', op: 'all_of', value: ['wholesale', 'missing'] },
      ]),
    ).toEqual([]);
    expect((await ids([{ field: 'tags', op: 'empty' }])).sort()).toEqual(
      [a, b, c].sort(),
    );
    expect(
      await ids([
        { field: 'discountCode', op: 'any_of', value: ['WELCOME10'] },
        { field: 'shippingMethod', op: 'any_of', value: ['Express'] },
        { field: 'channel', op: 'is', value: 'Online Store' },
        { field: 'test', op: 'is', value: true },
        { field: 'currency', op: 'is', value: 'EUR' },
      ]),
    ).toEqual([tagged]);
    // Orders that report no test flag are unknown, not false.
    expect(await ids([{ field: 'test', op: 'is', value: false }])).toEqual([]);
    const item = (await list()).items.find((order) => order.id === tagged);
    expect(item).toMatchObject({
      channel: 'Online Store',
      tags: ['priority', 'wholesale'],
      test: true,
    });
    const grouped = await list({ group: { field: 'tags' }, groupLimit: 5 });
    expect(grouped.groups?.map((group) => [group.key, group.count])).toEqual(
      expect.arrayContaining([
        ['priority', 1],
        ['wholesale', 1],
      ]),
    );
  }, 60000);

  it('filters, sorts, groups and pages orders by catalog conditions', async () => {
    const { a, b, c } = await seedWorkspace();
    const orders = workspace();

    type Query = Parameters<typeof orders.list>[1];

    const list = (query: Partial<Query> = {}, actor = context()) =>
      orders.list(actor, {
        q: '',
        count: 'exact',
        view: 'all',
        sort: 'updated',
        direction: 'desc',
        limit: 50,
        ...query,
      });
    const where = (
      conditions: NonNullable<Query['where']>['conditions'],
      match: 'all' | 'any' = 'all',
    ) => ({ where: { match, conditions } });
    const ids = async (query: Partial<Query>) =>
      (await list(query)).items.map((item) => item.id);
    const sorted = (values: string[]) => [...values].sort();

    expect(
      await ids(
        where([{ field: 'status', op: 'any_of', value: ['completed'] }]),
      ),
    ).toEqual([b]);
    expect(
      await ids(
        where([
          {
            field: 'total',
            op: 'gte',
            value: { amount: '40', currency: 'EUR' },
          },
        ]),
      ),
    ).toEqual([a]);
    // Amounts never match another currency, and missing totals never match a comparison.
    expect(
      await ids(
        where([
          { field: 'total', op: 'gt', value: { amount: '1', currency: 'USD' } },
        ]),
      ),
    ).toEqual([]);
    expect(
      await ids(
        where([
          {
            field: 'total',
            op: 'lt',
            value: { amount: '1000', currency: 'EUR' },
          },
        ]),
      ),
    ).toEqual([a]);
    expect(sorted(await ids(where([{ field: 'total', op: 'empty' }])))).toEqual(
      sorted([b, c]),
    );
    expect(
      await ids(where([{ field: 'lineCount', op: 'eq', value: 0 }])),
    ).toEqual([]);
    // Unknown overdue state matches neither true nor false.
    expect(
      await ids(where([{ field: 'overdue', op: 'is', value: true }])),
    ).toEqual([c]);
    expect(
      await ids(where([{ field: 'overdue', op: 'is', value: false }])),
    ).toEqual([b]);
    expect(
      sorted(
        await ids(
          where(
            [
              { field: 'status', op: 'any_of', value: ['completed'] },
              { field: 'overdue', op: 'is', value: true },
            ],
            'any',
          ),
        ),
      ),
    ).toEqual(sorted([b, c]));
    expect(
      await ids(where([{ field: 'needsYou', op: 'is', value: true }])),
    ).toEqual([a]);
    expect(
      await ids(where([{ field: 'hasIssue', op: 'is', value: true }])),
    ).toEqual([a]);
    expect(
      sorted(await ids(where([{ field: 'needsYou', op: 'is', value: false }]))),
    ).toEqual(sorted([b, c]));
    expect(
      await ids(where([{ field: 'source', op: 'any_of', value: [jtl] }])),
    ).toEqual([a]);
    expect(
      sorted(
        await ids(where([{ field: 'source', op: 'none_of', value: [jtl] }])),
      ),
    ).toEqual(sorted([b, c]));
    expect(
      await ids(
        where([{ field: 'placed', op: 'before', value: '2026-09-11' }]),
      ),
    ).toEqual([a]);
    // The read clock is 2026-09-20T12:00Z: nine local days back starts on 2026-09-11 in UTC,
    // but on 2026-09-12 in Kiritimati (UTC+14), where it is already 2026-09-21.
    const lastNineDays = where([
      { field: 'placed', op: 'within_last', value: { amount: 9, unit: 'day' } },
    ]);
    expect(sorted(await ids(lastNineDays))).toEqual(sorted([b, c]));
    expect(
      await ids({ ...lastNineDays, timeZone: 'Pacific/Kiritimati' }),
    ).toEqual([c]);
    await expect(
      list(where([{ field: 'number', op: 'contains', value: '1' }])),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Missing values sort last in both directions; totals sort within their currency.
    expect((await ids({ sort: 'total', direction: 'desc' }))[0]).toBe(a);
    expect((await ids({ sort: 'total', direction: 'asc' }))[0]).toBe(a);
    expect((await ids({ sort: 'status', direction: 'asc' })).at(-1)).toBe(b);
    expect((await ids({ sort: 'status', direction: 'desc' }))[0]).toBe(b);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({
        sort: 'total',
        direction: 'desc',
        limit: 1,
        cursor,
      });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen[0]).toBe(a);
    expect(sorted(seen)).toEqual(sorted([a, b, c]));

    // Groups count every match and list their first rows in sort order.
    const byStatus = await list({
      group: { field: 'status' },
      groupLimit: 1,
      sort: 'placed',
      direction: 'asc',
    });
    expect(byStatus.nextCursor).toBeNull();
    expect(
      byStatus.groups!.map((group) => [group.key, group.count, group.itemIds]),
    ).toEqual([
      ['open', 2, [a]],
      ['completed', 1, [b]],
    ]);
    expect(byStatus.groups![0]).toMatchObject({
      complete: true,
      sums: [{ field: 'total', currency: 'EUR', amount: '48' }],
    });
    expect(sorted(byStatus.items.map((item) => item.id))).toEqual(
      sorted([a, b]),
    );
    const rest = await list({
      group: { field: 'status' },
      groupKey: 'open',
      sort: 'placed',
      direction: 'asc',
      limit: 5,
      cursor: byStatus.groups![0]!.nextCursor!,
    });
    expect(rest.items.map((item) => item.id)).toEqual([c]);
    expect(rest.groups).toMatchObject([
      { key: 'open', count: 2, itemIds: [c] },
    ]);
    // A group's page link belongs to that group only.
    await expect(
      list({
        group: { field: 'status' },
        groupKey: 'completed',
        sort: 'placed',
        direction: 'asc',
        cursor: byStatus.groups![0]!.nextCursor!,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const byDay = await list({
      group: { field: 'placed', granularity: 'day' },
      timeZone: 'Pacific/Kiritimati',
    });
    expect(byDay.groups!.map((group) => [group.key, group.count])).toEqual([
      ['2026-09-10', 1],
      ['2026-09-11', 1],
      ['2026-09-12', 1],
    ]);
    const bySource = await list({ group: { field: 'source' } });
    expect(bySource.groups!.map((group) => [group.key, group.count])).toEqual(
      [
        [jtl, 1],
        [shopify, 3],
      ].sort(([x], [y]) => String(x).localeCompare(String(y))),
    );
    const byAttention = await list({ group: { field: 'needsYou' } });
    expect(
      byAttention.groups!.map((group) => [group.key, group.count]),
    ).toEqual([
      [true, 1],
      [false, 2],
    ]);
    const empty = await list({
      ...where([{ field: 'status', op: 'any_of', value: ['cancelled'] }]),
      group: { field: 'status' },
    });
    expect(empty).toMatchObject({ items: [], groups: [], totalCount: 0 });

    // Warehouse conditions need fulfillment access, like the warehouse filter.
    const ordersOnly = makeTenantContext(
      { userId: 'orders', sessionId: 'session' },
      {
        id: tenant,
        name: 'Fixture',
        slug: 'fixture',
        status: 'active',
        dataRegion: 'AU',
      },
      {
        ...builtInMembership(
          { id: 'm-orders', organizationId: tenant, userId: 'orders' },
          'member',
        ),
        permissions: new PermissionSet(['orders.read']),
      },
      randomUUID(),
    );
    await expect(
      list(
        where([{ field: 'warehouse', op: 'any_of', value: [randomUUID()] }]),
        ordersOnly,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      list({ group: { field: 'warehouse' } }, ordersOnly),
    ).rejects.toMatchObject({ statusCode: 403 });

    // Conditions wait for a complete projection instead of filtering the legacy read.
    await owner.query(
      'INSERT INTO orders_list_backfill(tenant_id) VALUES($1)',
      [tenant],
    );
    try {
      await expect(
        list(where([{ field: 'status', op: 'any_of', value: ['open'] }])),
      ).rejects.toMatchObject({ statusCode: 503 });
      await expect(list({ sort: 'total' })).rejects.toMatchObject({
        statusCode: 503,
      });
      expect((await list()).totalCount).toBe(3);
    } finally {
      await owner.query('DELETE FROM orders_list_backfill WHERE tenant_id=$1', [
        tenant,
      ]);
    }
  }, 60000);

  it('cites the orders the Orders page lists for the same filters, within one tenant', async () => {
    const { a, foreignOrder } = await seedWorkspace();
    const orders = workspace();
    const filters = {
      view: 'outstanding' as const,
      placedFrom: '2026-09-01T00:00:00+02:00',
    };
    const page = await orders.list(context(), {
      q: '',
      count: 'exact',
      view: 'outstanding',
      placedFrom: '2026-08-31T22:00:00.000Z',
      sort: 'updated',
      direction: 'desc',
      limit: 10,
    });
    expect(page.items.map((item) => item.id)).toContain(a);

    const ask = async (tenantId: string) => {
      let call = 0;
      const adapter: ModelAdapter = {
        region: 'AU',
        supportsZeroDataRetention: true,
        async generate(_route, request) {
          const usage = { inputTokens: 1, outputTokens: 1, costUsd: null };
          if (call++ === 0)
            return {
              text: '',
              toolCalls: [
                { id: 'search', name: 'search_orders', arguments: filters },
              ],
              usage,
            };
          // Cite every record the read returned, as a model following the prompt would.
          const result = request.messages.at(-1)!.content;

          return {
            text: `Outstanding: ${result.match(/\[\[order:[^\]]+\]\]/g)?.join(' ') ?? 'none'}`,
            toolCalls: [],
            usage,
          };
        },
      };
      const gateway = createModelGateway(
        {
          routes: {
            [assistantModelProfile]: {
              adapter: 'bedrock',
              model: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
              providers: ['bedrock'],
              zeroDataRetention: true,
            },
          },
          timeoutMs: 30_000,
        },
        createObservability({
          environment: 'test',
          release: 'test',
          sampleRate: 0,
        }),
        { bedrock: adapter },
      );
      const unavailable = async () => {
        throw new Error('Not read by this question');
      };
      const assistant = createWorkspaceAssistant({
        gateway,
        availability: { available: true, reason: null },
        reads: {
          orders,
          issues: { list: unavailable, get: unavailable },
          inventory: { list: unavailable },
          fulfillment: { list: unavailable },
          returns: { list: unavailable },
        },
        refreshContext: async (value) => value,
      });

      return assistant.ask(context(tenantId), {
        question: 'Which orders placed this month are still outstanding?',
        history: [],
      });
    };

    const answer = await ask(tenant);
    expect(answer.citations.map((item) => item.id)).toEqual(
      page.items.map((item) => item.id),
    );
    expect(answer.citations[0]).toMatchObject({
      kind: 'order',
      observedAt: page.items[0]!.observedAt,
    });

    const other = await ask(otherTenant);
    expect(other.citations.map((item) => item.id)).not.toContain(a);
    expect(other.citations.every((item) => item.id === foreignOrder)).toBe(
      true,
    );
  }, 60000);

  it('explains one order with source facts, progress, evidence and linked work', async () => {
    const { a, shipment, issueId } = await seedWorkspace();
    const definition = 'shipping-method';
    const digest = 'd'.repeat(64);
    const activation = randomUUID(),
      run = randomUUID();
    await owner.query(
      'INSERT INTO playbook_definitions(tenant_id,id,document) VALUES($1,$2,$3)',
      [tenant, definition, { id: definition, name: 'Correct shipping method' }],
    );
    await owner.query(
      'INSERT INTO playbook_versions(tenant_id,definition_id,version,digest,document) VALUES($1,$2,$3,$4,$5)',
      [
        tenant,
        definition,
        '1',
        digest,
        { definition: { id: definition }, version: '1', digest },
      ],
    );
    await owner.query(
      'INSERT INTO playbook_activations(tenant_id,id,definition_id,version,version_digest,document) VALUES($1,$2,$3,$4,$5,$6)',
      [
        tenant,
        activation,
        definition,
        '1',
        digest,
        {
          id: activation,
          tenantId: tenant,
          definitionId: definition,
          version: '1',
          versionDigest: digest,
        },
      ],
    );
    await owner.query(
      'INSERT INTO playbook_runs(tenant_id,id,activation_id,definition_id,version,version_digest,document) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        tenant,
        run,
        activation,
        definition,
        '1',
        digest,
        {
          id: run,
          tenantId: tenant,
          activationId: activation,
          definitionId: definition,
          version: '1',
          versionDigest: digest,
          createdAt: '2026-09-19T12:00:00Z',
          incidentId: randomUUID(),
          action: { id: run, target: { kind: 'order', id: 'jtl-order-10' } },
        },
      ],
    );

    const detail = (await workspace().get(context(), a))!;
    expect(detail.order).toMatchObject({
      id: a,
      displayNumber: 'SO-10',
      differs: false,
      comparisonState: 'inconclusive',
      issueIds: [issueId],
    });
    const shop = detail.sources.find((item) => item.connectionId === shopify)!;
    expect(shop).toMatchObject({
      selected: false,
      appId: 'shopify',
      externalId: 'gid://shopify/Order/1001',
      mappingMethod: 'operator-confirmed',
      fulfillment: 'partial',
      lines: [
        {
          skuCode: 'TOTE-RED',
          title: 'Canvas tote',
          quantity: '2',
          fulfilledQuantity: '1',
          remainingQuantity: '1',
        },
      ],
    });
    expect(
      detail.sources.find((item) => item.connectionId === jtl),
    ).toMatchObject({ selected: true, fulfillment: 'unfulfilled' });
    expect(detail.differences.map((item) => item.field)).toEqual([
      'paymentStatus',
      'fulfilledQuantity',
      'remainingQuantity',
      'fulfillment',
    ]);
    expect(detail.fulfillments).toMatchObject([
      {
        id: shipment,
        connectionId: shopify,
        status: 'shipped',
        externalId: 'gid://shopify/Fulfillment/51',
      },
    ]);
    expect(detail.issues).toMatchObject([
      {
        id: issueId,
        class: 'stuck_fulfillment',
        relationship: 'fulfillment',
        needsYou: true,
      },
    ]);
    expect(detail.workflows).toMatchObject([
      {
        id: run,
        name: 'Correct shipping method',
        relationship: 'order',
        state: 'recorded',
      },
    ]);
    expect(detail.history.entries).toHaveLength(3);
    expect(
      detail.history.entries.every((entry) => entry.current === true),
    ).toBe(true);
    expect(detail.history.entries.map((entry) => entry.entityKind)).toEqual(
      expect.arrayContaining(['order', 'fulfillment']),
    );
    expect(detail.activity.entries).toMatchObject([
      { exceptionId: issueId, action: 'exception.detected' },
    ]);

    const app = buildApp(
      {},
      {
        orders: workspace(),
        trustedOrigins: ['http://localhost:3000'],
        identity: {
          hasSupportView: () => false,
          resolveTenant: async (_credentials: unknown, id: string) =>
            context(id),
        } as unknown as IdentityService,
      },
    );
    try {
      const base = `/v1/organizations/${tenant}/orders`;
      const listed = await app.inject(`${base}?q=tote-red&view=needs_you`);
      expect(listed.statusCode).toBe(200);
      expect(
        listed.json().items.map((item: { id: string }) => item.id),
      ).toEqual([a]);
      expect((await app.inject(`${base}/${a}`)).statusCode).toBe(200);
      expect((await app.inject(`${base}/${randomUUID()}`)).statusCode).toBe(
        404,
      );
      expect((await app.inject(`${base}?cursor=not-a-cursor`)).statusCode).toBe(
        400,
      );
      expect((await app.inject(`${base}?limit=101`)).statusCode).toBe(400);
      expect(
        (await app.inject(`/v1/organizations/${otherTenant}/orders/${a}`))
          .statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  }, 60000);

  it('keeps short, Unicode and wildcard searches literal and source scoped', async () => {
    const { a } = await seedWorkspace();
    const special = await seedOrder({
      connectionId: shopify,
      external: 'literal-source',
      key: 'literal',
      updatedAt: '2026-09-19T11:00:00Z',
      data: { displayNumber: 'Ä_%\\東京' },
      lines: [
        {
          external: 'literal-line',
          key: 'literal-line',
          quantity: '1',
          skuCode: 'ABCD',
        },
      ],
    });
    const list = (q: string, connectionId?: string) =>
      workspace().list(context(), {
        q,
        connectionId,
        view: 'all',
        sort: 'updated',
        direction: 'desc',
        limit: 50,
      });
    for (const q of ['ä', '_', '%', '\\', '東京', 'BC', 'Ä_%\\東京'])
      expect((await list(q)).items.map((x) => x.id)).toContain(special);
    expect((await list('東京AB')).items).toEqual([]);
    expect((await list('#1001', jtl)).items).toEqual([]);
    expect((await list('jtl-item-77', shopify)).items).toEqual([]);
    expect((await list('jtl-item-77', jtl)).items.map((x) => x.id)).toEqual([
      a,
    ]);
    expect((await list(a.toUpperCase())).items.map((x) => x.id)).toEqual([a]);
    expect((await list('')).totalCount).toBeNull();
    await createTenantDatabase(reader).transaction(otherTenant, async (tx) => {
      for (const table of [
        'orders_list',
        'orders_search_values',
        'orders_search_links',
        'orders_search_grams',
        'orders_list_skus',
        'connector_mapping_grams',
      ])
        expect(
          (
            await tx.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [
              tenant,
            ])
          ).rowCount,
        ).toBe(0);
      await expect(
        tx.query('DELETE FROM orders_list WHERE tenant_id=$1', [otherTenant]),
      ).rejects.toThrow('permission denied');
    });
  });

  it('indexes mapping-only aliases atomically without republishing orders', async () => {
    const { a } = await seedWorkspace();
    // Projection exposes connection identity on its snapshot.
    const current = (await services.orders.current(context(), a)).find(
      (p) => p.snapshot.connectionId === shopify,
    )!;
    const stored = await services.sources.get(
      context(),
      shopify,
      current.snapshot.observationId,
    );
    const input = structuredClone(stored!);
    if (input.capability !== 'orders.read') throw new Error('Expected order');
    input.observation.id = randomUUID();
    input.observation.data.lines[0]!.sku = {
      externalId: 'new-alias-%',
      scopeKey: '',
    };
    const source = {
      ...input.observation.source,
      resource: 'sku' as const,
      externalId: 'new-alias-%',
      scopeKey: '',
    };
    await services.sources.record(context(), input.observation.id, input);
    const query = {
      q: 'new-alias-%',
      view: 'all' as const,
      sort: 'updated' as const,
      direction: 'desc' as const,
      limit: 50,
    };
    expect((await workspace().list(context(), query)).items).toEqual([]);
    await services.ingestion.bind(
      context(),
      source,
      'tote',
      input.observation.id,
      'operator-confirmed',
    );
    expect(
      (await workspace().list(context(), query)).items.map((x) => x.id),
    ).toEqual([a]);
    expect(
      (await services.orders.current(context(), a)).find(
        (p) => p.snapshot.connectionId === shopify,
      )?.snapshotId,
    ).toBe(current.snapshotId);
  });

  it('streams common source aliases without truncating broad search results', async () => {
    const { a } = await seedWorkspace();
    // Bulk alias evidence exercises the postings query beyond its 1,001-reference probe.
    await owner.query(
      `INSERT INTO connector_source_mappings(id,tenant_id,connection_id,resource,scope_key,external_id,canonical_id,observation_id,method,actor_id)
      SELECT gen_random_uuid(),tenant_id,connection_id,resource,scope_key,'common-alias-'||n,canonical_id,observation_id,method,actor_id
      FROM connector_source_mappings CROSS JOIN generate_series(1,1500) n
      WHERE tenant_id=$1 AND canonical_id=$2 AND resource='order' AND connection_id=$3`,
      [tenant, a, shopify],
    );
    await owner.query('ANALYZE connector_mapping_grams');
    await owner.query('ANALYZE connector_source_mappings');
    const query = {
      q: 'common-alias',
      view: 'all' as const,
      sort: 'updated' as const,
      direction: 'desc' as const,
      limit: 50,
    };
    expect(
      (await workspace().list(context(), query)).items.map((x) => x.id),
    ).toEqual([a]);
    expect(
      (await workspace().list(context(), { ...query, q: 'common-alias-z' }))
        .items,
    ).toEqual([]);
    expect(
      (await workspace().list(context(), { ...query, connectionId: jtl }))
        .items,
    ).toEqual([]);
  }, 30000);

  it('matches customer names and emails only for readers who can read customers', async () => {
    const { a } = await seedWorkspace();
    const profile = (name: string, external: string) =>
      owner.query(
        `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,display_name,email,state,
          contact_shared,address_shared,observed_at,observation_id)
         VALUES($1,$2,$3,gen_random_uuid(),$4,$5,'enabled',true,false,now(),gen_random_uuid())`,
        [tenant, shopify, external, name, `${external}@example.test`],
      );
    await profile('Mira Sato', 'mira');
    await owner.query(
      `INSERT INTO customer_orders(tenant_id,connection_id,order_scope_key,order_external_id,customer_external_id,observed_at)
       VALUES($1,$2,'','gid://shopify/Order/1001','mira',now())`,
      [tenant, shopify],
    );
    const query = {
      q: 'mira sato',
      view: 'all' as const,
      sort: 'updated' as const,
      direction: 'desc' as const,
      limit: 50,
    };
    const ordersOnly = {
      ...context(),
      permissions: new PermissionSet(['orders.read']),
    };
    expect(
      (await workspace().list(context(), query)).items.map((x) => x.id),
    ).toEqual([a]);
    expect(
      (
        await workspace().list(context(), { ...query, q: 'MIRA@EXAMPLE' })
      ).items.map((x) => x.id),
    ).toEqual([a]);
    expect(
      (await workspace().list(context(), { ...query, connectionId: jtl }))
        .items,
    ).toEqual([]);
    expect((await workspace().list(ordersOnly, query)).items).toEqual([]);

    // A customer with more than 1,000 orders switches to the broad plan, which checks rows
    // in sort order instead of binding every order ID.
    await profile('Common Buyer', 'common');
    await owner.query(
      `INSERT INTO connector_source_mappings(id,tenant_id,connection_id,resource,scope_key,external_id,canonical_id,observation_id,method,actor_id)
       SELECT gen_random_uuid(),tenant_id,connection_id,'order','','bulk-order-'||n,gen_random_uuid(),observation_id,method,actor_id
       FROM connector_source_mappings CROSS JOIN generate_series(1,1100) n
       WHERE tenant_id=$1 AND canonical_id=$2 AND resource='order' AND connection_id=$3`,
      [tenant, a, shopify],
    );
    await owner.query(
      `INSERT INTO customer_orders(tenant_id,connection_id,order_scope_key,order_external_id,customer_external_id,observed_at)
       SELECT $1,$2,'','bulk-order-'||n,'common',now() FROM generate_series(1,1100) n`,
      [tenant, shopify],
    );
    // The order Mira placed now belongs to the common buyer.
    await owner.query(
      `UPDATE customer_orders SET customer_external_id='common' WHERE tenant_id=$1 AND order_external_id='gid://shopify/Order/1001'`,
      [tenant],
    );
    const broad = { ...query, q: 'common buyer' };
    expect(
      (await workspace().list(context(), broad)).items.map((x) => x.id),
    ).toEqual([a]);
    expect((await workspace().list(ordersOnly, broad)).items).toEqual([]);
  }, 30000);

  it('publishes search and state atomically, preserves replay and rejects stale snapshots', async () => {
    const { a } = await seedWorkspace();
    const current = (await services.orders.current(context(), a)).find(
      (p) => p.snapshot.connectionId === shopify,
    )!;
    const updated = structuredClone(current.snapshot);
    if (updated.data.type !== 'order') throw new Error('Expected order');
    updated.normalizerVersion = 'test/search-v2';
    updated.data.displayNumber = 'REPLACED';
    expect(await services.orders.project(context(), updated)).toBe('applied');
    expect(await services.orders.project(context(), updated)).toBe('duplicate');
    const query = {
      q: 'REPLACED',
      view: 'all' as const,
      sort: 'updated' as const,
      direction: 'desc' as const,
      limit: 50,
    };
    expect(
      (await workspace().list(context(), query)).items.map((x) => x.id),
    ).toEqual([a]);
    expect(
      (await workspace().list(context(), { ...query, q: '#1001' })).items,
    ).toEqual([]);
    const observation = structuredClone(
      (await services.sources.get(
        context(),
        shopify,
        current.snapshot.observationId,
      ))!,
    );
    observation.observation.id = randomUUID();
    await services.sources.record(
      context(),
      observation.observation.id,
      observation,
    );
    const stale = {
      ...updated,
      observationId: observation.observation.id,
      sourceUpdatedAt: '2020-01-01T00:00:00Z',
      data: { ...updated.data, displayNumber: 'STALE' },
    };
    expect(await services.orders.project(context(), stale)).toBe('retained');
    expect(await services.orders.project(context(), stale)).toBe('duplicate');
    expect(
      (await workspace().list(context(), { ...query, q: 'STALE' })).items,
    ).toEqual([]);
    await owner.query(
      "ALTER TABLE orders_list ADD CONSTRAINT reject_test CHECK(display_number IS DISTINCT FROM 'reject-write')",
    );
    try {
      await expect(
        services.orders.project(context(), {
          ...updated,
          normalizerVersion: 'test/failed',
          data: { ...updated.data, displayNumber: 'reject-write' },
        }),
      ).rejects.toThrow('reject_test');
      expect(
        (await services.orders.current(context(), a)).find(
          (p) => p.snapshot.connectionId === shopify,
        )?.snapshot.normalizerVersion,
      ).toBe('test/search-v2');
      expect(
        (await services.orders.history(context(), a)).some(
          (s) => s.normalizerVersion === 'test/failed',
        ),
      ).toBe(false);
    } finally {
      await owner.query('ALTER TABLE orders_list DROP CONSTRAINT reject_test');
    }
    const tombstone = {
      ...updated,
      normalizerVersion: 'test/tombstone',
      deleted: true,
    };
    await services.orders.project(context(), tombstone);
    const removed = await workspace().list(context(), {
      ...query,
      connectionId: shopify,
    });
    expect(removed.items).toEqual([]);
    expect((await workspace().list(context(), query)).items).toEqual([]);
    expect(
      (await workspace().list(context(), { ...query, q: a })).items.map(
        (item) => item.id,
      ),
    ).toContain(a);
  });

  it('serializes sibling fulfillments and evaluates future observations at read time', async () => {
    const { c } = await seedWorkspace();
    await Promise.all(
      ['split-a', 'split-b'].map((external) =>
        seedShipment({
          connectionId: shopify,
          order: 'gid://shopify/Order/1003',
          external,
          line: 'gid://shopify/LineItem/13',
          quantity: '2',
          status: 'shipped',
        }),
      ),
    );
    const query = {
      q: c,
      view: 'all' as const,
      sort: 'updated' as const,
      direction: 'desc' as const,
      limit: 50,
    };
    expect(
      (await workspace().list(context(), query)).items[0]?.fulfillment,
    ).toBe('fulfilled');
    const shipment = (
      await owner.query<{ canonical_id: string }>(
        "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND external_id='split-b'",
        [tenant],
      )
    ).rows[0]!.canonical_id;
    const current = (await services.orders.current(context(), shipment))[0]!;
    await services.orders.project(context(), {
      ...current.snapshot,
      normalizerVersion: 'test/future',
      observedAt: '2026-09-22T00:00:00Z',
    });
    const before = (await workspace().list(context(), query)).items[0]!;
    expect(before.fulfillment).toBe('partial');
    expect(before.open).toBe(true);
    expect(before.overdue).toBe(true);
    clock = new Date('2026-09-23T00:00:00Z');
    expect((await workspace().list(context(), query)).items[0]?.open).toBe(
      false,
    );
  });

  it('keeps legacy reads until the final backfill batch and repairs rows idempotently', async () => {
    await seedWorkspace();
    const query = {
      q: '',
      view: 'all' as const,
      sort: 'updated' as const,
      direction: 'desc' as const,
      limit: 1,
    };
    const expected = await workspace().list(context(), {
      ...query,
      limit: 50,
      count: 'exact',
    });
    await owner.query(
      'INSERT INTO orders_list_backfill(tenant_id) VALUES($1)',
      [tenant],
    );
    await owner.query('DELETE FROM orders_list WHERE tenant_id=$1', [tenant]);
    expect(
      await workspace().list(context(), {
        ...query,
        limit: 50,
        count: 'exact',
      }),
    ).toEqual({
      ...expected,
      // Legacy reads do not project commercial facts; they stay absent rather than empty.
      items: expected.items.map((item) => ({
        ...Object.fromEntries(
          Object.entries(item).filter(
            ([key]) => !['channel', 'tags', 'test'].includes(key),
          ),
        ),
        differs: false,
        comparisonState: 'inconclusive',
      })),
    });
    const rebuild = createOrderListRebuilder(createTenantDatabase(writer));
    let after = await rebuild(context(), undefined, 1);
    expect(after).not.toBeNull();
    expect(
      (
        await owner.query(
          'SELECT 1 FROM orders_list_backfill WHERE tenant_id=$1',
          [tenant],
        )
      ).rowCount,
    ).toBe(1);
    await expect(rebuild(context(), randomUUID(), 1)).rejects.toThrow(
      'checkpoint',
    );
    const current = (
      await services.orders.current(context(), expected.items[0]!.id)
    )[0]!;
    [after] = await Promise.all([
      rebuild(context(), undefined, 1),
      services.orders.project(context(), {
        ...current.snapshot,
        normalizerVersion: 'test/backfill-race',
      }),
    ]);
    while (after) after = await rebuild(context(), after, 1);
    expect(
      (
        await owner.query(
          'SELECT 1 FROM orders_list_backfill WHERE tenant_id=$1',
          [tenant],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      await workspace().list(context(), {
        ...query,
        limit: 50,
        count: 'exact',
      }),
    ).toEqual(expected);
    await rebuild(context());
    expect(
      await workspace().list(context(), {
        ...query,
        limit: 50,
        count: 'exact',
      }),
    ).toEqual(expected);
    const first = await workspace().list(context(), query);
    const second = await workspace().list(context(), {
      ...query,
      cursor: first.nextCursor!,
      count: 'exact',
    });
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(second.totalCount).toBe(3);
    const removed = expected.items[0]!.id;
    await owner.query(
      'DELETE FROM orders_projections WHERE tenant_id=$1 AND entity_id=$2 AND connection_id=$3',
      [tenant, removed, shopify],
    );
    await rebuild(context());
    expect(
      (
        await workspace().list(context(), {
          ...query,
          q: removed,
          connectionId: shopify,
        })
      ).items,
    ).toEqual([]);
  });

  it('pages a large import completely and in order', async () => {
    const count = Number(process.env.LUMA_ORDER_BENCHMARK ?? 2000);
    const { a } = await seedWorkspace();
    const template = async (connectionId: string) =>
      (
        await owner.query<{
          document: Record<string, unknown>;
          mapping: string;
        }>(
          `SELECT s.document,s.mapping_version AS mapping FROM orders_projections p
         JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
         WHERE p.tenant_id=$1 AND p.entity_id=$2 AND p.connection_id=$3`,
          [tenant, a, connectionId],
        )
      ).rows[0]!;
    const shop = await template(shopify);
    const erp = await template(jtl);
    // Historical orders with source dates, totals and SKU text on two connections.
    await owner.query(
      `WITH entities AS (
        INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key)
        SELECT gen_random_uuid(),$1,'order','import-' || n FROM generate_series(1,$6::int) n RETURNING id,reconciliation_key
      ), numbered AS (
        SELECT id,substr(reconciliation_key,8)::int AS n FROM entities
      ), sources AS (
        SELECT e.*,c.connection_id,c.offset_minutes FROM numbered e
        CROSS JOIN (VALUES ($2::uuid,0),($3::uuid,5)) c(connection_id,offset_minutes)
        WHERE c.connection_id=$2 OR e.n % 3 = 0
      ), snapshots AS (
        INSERT INTO orders_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,mapping_version,source_updated_at,observed_at,document)
        SELECT gen_random_uuid(),$1,s.id,'order',s.connection_id,
          CASE WHEN s.connection_id=$2 THEN $4 ELSE $8 END::uuid,'import/1',$5,
          timestamptz '2024-01-01' + s.n * interval '17 minutes',timestamptz '2026-09-19',
          jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set($7::jsonb,
            '{entityId}',to_jsonb(s.id::text)),'{connectionId}',to_jsonb(s.connection_id::text)),
            '{observationId}',to_jsonb(CASE WHEN s.connection_id=$2 THEN $4 ELSE $8 END::text)),
            '{sourceUpdatedAt}',to_jsonb(to_char((timestamptz '2024-01-01' + s.n * interval '17 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
            '{data,displayNumber}',to_jsonb('#' || (100000 + s.n))),
            '{data,placedAt}',to_jsonb(to_char((timestamptz '2024-01-01' + s.n * interval '13 minutes' + s.offset_minutes * interval '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
            '{data,status}',to_jsonb(CASE WHEN s.n % 4 = 0 THEN 'completed' ELSE 'open' END)),
            '{data,total}',jsonb_build_object('amount',round((s.n * 37) % 100000 / 100.0,2)::text,'currency',CASE WHEN s.n % 5 = 0 THEN 'USD' ELSE 'EUR' END))
        FROM sources s RETURNING entity_id,connection_id,id
      ) INSERT INTO orders_projections(tenant_id,entity_id,connection_id,snapshot_id)
        SELECT $1,entity_id,connection_id,id FROM snapshots`,
      [
        tenant,
        shopify,
        jtl,
        shop.document.observationId,
        shop.mapping,
        count,
        shop.document,
        erp.document.observationId,
      ],
    );
    await owner.query('ANALYZE');
    const rebuildStart = performance.now();
    const rebuild = createOrderListRebuilder(createTenantDatabase(writer));
    let after: string | null | undefined;
    do {
      after = await rebuild(context(), after ?? undefined, 2000);
    } while (after);
    // Production tables carry planner statistics; a bulk load needs them before plans are measured.
    await owner.query('ANALYZE');
    await owner.query('ANALYZE orders_projections');
    await owner.query('ANALYZE orders_snapshots');
    const rebuildMs = Math.round(performance.now() - rebuildStart);
    const plans: Record<string, string> = {};
    let explain: string | null = null;
    const db = createTenantDatabase(reader);
    // Benchmark runs record one plan per measured query for the performance guide.
    const planned = createOrderWorkspace(
      {
        transaction: (tenantId, operation, options) =>
          db.transaction(
            tenantId,
            (tx) =>
              operation({
                query: async (sql, values) => {
                  if (
                    explain &&
                    (sql.startsWith('WITH future_sources') ||
                      sql.startsWith('WITH order_sources') ||
                      sql.startsWith('WITH search_grams'))
                  )
                    plans[
                      sql.startsWith('WITH search_grams')
                        ? `${explain}:candidates`
                        : explain
                    ] = (
                      await tx.query<{ 'QUERY PLAN': string }>(
                        'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ' + sql,
                        values,
                      )
                    ).rows
                      .map((row) => row['QUERY PLAN'])
                      .join('\n');

                  return tx.query(sql, values);
                },
              }),
            options,
          ),
      },
      {
        state: orderStateQueries,
        attention: orderAttentionQuery,
        attentionFor: orderAttentionForOrders,
      },
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
      () => clock,
    );
    const orders = workspace();
    const query = {
      q: '',
      view: 'all' as const,
      sort: 'placed' as const,
      direction: 'asc' as const,
      limit: 100,
    };
    const timings: Record<string, number> = {};
    const timed = async <T>(
      label: string,
      read: (workspace: typeof orders) => Promise<T>,
    ) => {
      const start = performance.now();
      const result = await read(orders);
      timings[label] = Math.round(performance.now() - start);
      if (process.env.LUMA_ORDER_BENCHMARK) {
        explain = label;
        await read(planned);
        explain = null;
      }

      return result;
    };
    const firstPage = await timed('first page, placed', (workspace) =>
      workspace.list(context(), query),
    );
    expect(firstPage.totalCount).toBeNull();
    expect(
      (await orders.list(context(), { ...query, count: 'exact' })).totalCount,
    ).toBe(count + 3);
    // The default import is walked end to end; a benchmark import walks its first pages.
    const benchmark = !!process.env.LUMA_ORDER_BENCHMARK;
    const seen = new Set<string>();
    let previous = '';
    let cursor: string | undefined;
    let pages = 0;
    const walkStart = performance.now();
    do {
      const page = await orders.list(context(), { ...query, cursor });
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
        const placed = item.placedAt ?? '9999';
        expect(placed >= previous).toBe(true);
        previous = placed;
      }
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && (!benchmark || pages < 10));
    timings['average cursor page'] = Math.round(
      (performance.now() - walkStart) / pages,
    );
    if (!benchmark) expect(seen.size).toBe(count + 3);
    await timed('default sort', (workspace) =>
      workspace.list(context(), {
        ...query,
        sort: 'updated',
        direction: 'desc',
      }),
    );
    const searched = await timed('number search', (workspace) =>
      workspace.list(context(), { ...query, q: String(100000 + count - 1) }),
    );
    expect(searched.items).toHaveLength(1);
    await timed('outstanding view', (workspace) =>
      workspace.list(context(), { ...query, view: 'outstanding' }),
    );
    await timed('differs view', (workspace) =>
      workspace.list(context(), { ...query, view: 'differs' }),
    );
    await timed('SKU search', (workspace) =>
      workspace.list(context(), { ...query, q: 'tote-red' }),
    );
    await timed('connection page', (workspace) =>
      workspace.list(context(), { ...query, connectionId: jtl }),
    );
    await timed('short search', (workspace) =>
      workspace.list(context(), { ...query, q: '1' }),
    );
    await timed('exact count', (workspace) =>
      workspace.list(context(), { ...query, count: 'exact' }),
    );
    // Jump to the middle using the same cursor context to verify a real deep keyset seek.
    const middle = (
      await owner.query<{ entity_id: string; placed_key: string }>(
        'SELECT entity_id,placed_key FROM orders_list WHERE tenant_id=$1 AND selected ORDER BY placed_rank,placed_key,entity_id OFFSET $2 LIMIT 1',
        [tenant, Math.floor(count / 2)],
      )
    ).rows[0]!;
    const position = JSON.parse(
      Buffer.from(firstPage.nextCursor!, 'base64url').toString(),
    );
    position.keys = [middle.placed_key];
    position.id = middle.entity_id;
    const deep = await timed('deep cursor', (workspace) =>
      workspace.list(context(), {
        ...query,
        cursor: Buffer.from(JSON.stringify(position)).toString('base64url'),
      }),
    );
    expect(deep.items).toHaveLength(100);
    // Catalog conditions, new sorts and groups over the same import.
    const conditions = (
      list: NonNullable<
        Parameters<typeof orders.list>[1]['where']
      >['conditions'],
    ) => ({ ...query, where: { match: 'all' as const, conditions: list } });
    await timed('where status and total', (workspace) =>
      workspace.list(
        context(),
        conditions([
          { field: 'status', op: 'any_of', value: ['open'] },
          {
            field: 'total',
            op: 'gte',
            value: { amount: '900', currency: 'EUR' },
          },
        ]),
      ),
    );
    await timed('where placed within last 30 days', (workspace) =>
      workspace.list(
        context(),
        conditions([
          {
            field: 'placed',
            op: 'within_last',
            value: { amount: 30, unit: 'day' },
          },
        ]),
      ),
    );
    await timed('needs-you view', (workspace) =>
      workspace.list(context(), { ...query, view: 'needs_you' }),
    );
    await timed('where needs you', (workspace) =>
      workspace.list(
        context(),
        conditions([{ field: 'needsYou', op: 'is', value: true }]),
      ),
    );
    await timed('where needs you or overdue', (workspace) =>
      workspace.list(context(), {
        ...query,
        where: {
          match: 'any',
          conditions: [
            { field: 'needsYou', op: 'is', value: true },
            { field: 'overdue', op: 'is', value: true },
          ],
        },
      }),
    );
    await timed('where source none of', (workspace) =>
      workspace.list(
        context(),
        conditions([{ field: 'source', op: 'none_of', value: [jtl] }]),
      ),
    );
    const byTotal = await timed('total sort', (workspace) =>
      workspace.list(context(), { ...query, sort: 'total', direction: 'desc' }),
    );
    await timed('total sort, second page', (workspace) =>
      workspace.list(context(), {
        ...query,
        sort: 'total',
        direction: 'desc',
        cursor: byTotal.nextCursor!,
      }),
    );
    await timed('status sort', (workspace) =>
      workspace.list(context(), { ...query, sort: 'status' }),
    );
    await timed('line count sort', (workspace) =>
      workspace.list(context(), {
        ...query,
        sort: 'lineCount',
        direction: 'desc',
      }),
    );
    const grouped = await timed('group by status', (workspace) =>
      workspace.list(context(), { ...query, group: { field: 'status' } }),
    );
    expect(grouped.groups!.reduce((sum, group) => sum + group.count, 0)).toBe(
      count + 3,
    );
    await timed('group by placed week', (workspace) =>
      workspace.list(context(), {
        ...query,
        group: { field: 'placed', granularity: 'week' },
        timeZone: 'Europe/Berlin',
      }),
    );
    await timed('group by source', (workspace) =>
      workspace.list(context(), { ...query, group: { field: 'source' } }),
    );
    await timed('page within status group', (workspace) =>
      workspace.list(context(), {
        ...query,
        group: { field: 'status' },
        groupKey: 'open',
        cursor: grouped.groups![0]!.nextCursor!,
      }),
    );
    await timed('detail', (workspace) => workspace.get(context(), a));
    if (process.env.LUMA_ORDER_BENCHMARK) {
      const { writeFile } = await import('node:fs/promises');
      const storage = (
        await owner.query(`SELECT relname,pg_total_relation_size(oid)::text AS bytes FROM pg_class
        WHERE relnamespace='public'::regnamespace AND relkind='r' AND (relname LIKE 'orders_%' OR relname='connector_mapping_grams') ORDER BY relname`)
      ).rows;
      const existing = (await services.orders.current(context(), a))[0]!
        .snapshot;
      const writeStart = performance.now();
      await services.orders.project(context(), {
        ...existing,
        normalizerVersion: 'benchmark/reindex',
      });
      timings['order update'] = Math.round(performance.now() - writeStart);
      const writeDb = createTenantDatabase(writer);
      const profiled = createCommerceServices({
        transaction: (tenantId, operation, options) =>
          writeDb.transaction(
            tenantId,
            (tx) =>
              operation({
                query: async (sql, values) => {
                  if (
                    sql.startsWith('WITH sources AS') ||
                    sql.startsWith('WITH comparisons AS') ||
                    sql.startsWith('WITH search_values AS') ||
                    sql.startsWith('WITH inserted AS')
                  ) {
                    plans[`write:${sql.split('\n')[0]}`] = (
                      await tx.query<{ 'QUERY PLAN': string }>(
                        'EXPLAIN (ANALYZE,BUFFERS,FORMAT TEXT) ' + sql,
                        values,
                      )
                    ).rows
                      .map((row) => row['QUERY PLAN'])
                      .join('\n');

                    return { rows: [], rowCount: 0 };
                  }

                  return tx.query(sql, values);
                },
              }),
            options,
          ),
      });
      await profiled.orders.project(context(), {
        ...existing,
        normalizerVersion: 'benchmark/profile',
      });
      await profiled.close();
      await writeFile(
        `/tmp/luma116-order-queries-${count}.json`,
        JSON.stringify(
          { orders: count + 3, rebuildMs, storage, timings, plans },
          null,
          2,
        ),
      );
      expect(plans['first page, placed']).toMatch(
        /Index (?:Only )?Scan(?: Backward)? using orders_list_placed/,
      );
      expect(plans['deep cursor']).toMatch(
        /Index Cond:.*ROW\(placed_key, entity_id\)/,
      );
      expect(plans['SKU search']).toContain('orders_search_order');
      expect(plans['SKU search']).not.toContain('hashed SubPlan');
      expect(plans['write:WITH search_values AS MATERIALIZED (']).toContain(
        'value_hash = v.value_hash',
      );
      expect(plans['write:WITH search_values AS MATERIALIZED (']).not.toContain(
        'Seq Scan on orders_search_values',
      );
      expect(plans['number search:candidates']).not.toContain(
        'Seq Scan on orders_search_values',
      );
      expect(plans['short search:candidates']).not.toContain(
        'Seq Scan on orders_search_values',
      );
    }
  }, 1800000);
  it('persists change times across polls and agrees on pending, confirmed and stale list/detail comparisons', async () => {
    const base = {
      connectionId: shopify,
      external: 'lag-shop',
      key: 'lag-order',
      updatedAt: '2026-09-20T11:59:00Z',
      data: {},
      lines: [
        {
          external: 'lag-line',
          key: 'lag-line',
          quantity: '2',
          current: '2',
          sku: { external: 'lag-sku', key: 'lag-sku' },
        },
      ],
    };
    const erp = { ...base, connectionId: jtl, external: 'lag-erp' };
    const id = await seedOrder(base);
    await seedOrder(erp);
    const changed = {
      ...base,
      updatedAt: '2026-09-20T12:00:00Z',
      lines: [{ ...base.lines[0]!, current: '1', cancelled: '1' }],
    };
    await seedOrder(changed);
    const orders = workspace();
    const query = {
      q: '',
      view: 'differs' as const,
      sort: 'updated' as const,
      direction: 'desc' as const,
      limit: 50,
    };
    const pending = (await orders.get(context(), id))!;
    expect(pending.order).toMatchObject({
      differs: false,
      comparisonState: 'pending',
    });
    expect(pending.differences.map((item) => item.field)).toEqual([
      'currentQuantity',
      'cancelledQuantity',
      'remainingQuantity',
    ]);
    expect(pending.differences[0]?.authority).toMatchObject({
      connectionId: shopify,
      state: 'resolved',
    });
    expect(pending.differences[0]?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectionId: shopify,
          value: '1',
          evidence: [
            expect.objectContaining({ observedAt: '2026-09-20T12:00:00Z' }),
          ],
        }),
      ]),
    );
    expect((await orders.list(context(), query)).items).toEqual([]);
    const previous = (
      await owner.query(
        'SELECT comparison_changed_at FROM orders_list WHERE tenant_id=$1 AND entity_id=$2 AND connection_id=$3',
        [tenant, id, shopify],
      )
    ).rows[0];
    clock = new Date('2026-09-20T12:16:00Z');
    await seedOrder({ ...changed, updatedAt: clock.toISOString() });
    expect((await orders.get(context(), id))?.order.comparisonState).toBe(
      'inconclusive',
    );
    await seedOrder({ ...erp, updatedAt: clock.toISOString() });
    expect(
      (
        await owner.query(
          'SELECT comparison_changed_at FROM orders_list WHERE tenant_id=$1 AND entity_id=$2 AND connection_id=$3',
          [tenant, id, shopify],
        )
      ).rows[0],
    ).toEqual(previous);
    expect((await orders.get(context(), id))?.order).toMatchObject({
      differs: true,
      comparisonState: 'confirmed',
    });
    expect(
      (await orders.list(context(), query)).items.map((item) => item.id),
    ).toEqual([id]);
    // A newer partial collection page makes the comparison inconclusive without rewriting order evidence.
    await owner.query(
      `INSERT INTO connector_read_checks(tenant_id,connection_id,capability,observed_at,succeeded,document)
      VALUES($1,$2,'fulfillment.read',$3,true,$4)`,
      [
        tenant,
        jtl,
        clock.toISOString(),
        {
          ok: true,
          value: { completeness: 'partial', nextCursor: null, items: [] },
        },
      ],
    );
    expect((await orders.get(context(), id))?.order).toMatchObject({
      differs: false,
      comparisonState: 'inconclusive',
    });
    expect((await orders.list(context(), query)).items).toEqual([]);
    await owner.query(
      `INSERT INTO connector_read_checks(tenant_id,connection_id,capability,observed_at,succeeded,document)
      VALUES($1,$2,'fulfillment.read',$3,true,$4)`,
      [
        tenant,
        jtl,
        clock.toISOString(),
        {
          ok: true,
          value: { completeness: 'complete', nextCursor: null, items: [] },
        },
      ],
    );
    expect((await orders.get(context(), id))?.order.comparisonState).toBe(
      'confirmed',
    );
    clock = new Date('2026-09-20T12:22:00Z');
    expect((await orders.get(context(), id))?.order).toMatchObject({
      differs: false,
      comparisonState: 'inconclusive',
    });
    expect((await orders.list(context(), query)).items).toEqual([]);
    clock = new Date('2026-09-20T12:23:00Z');
    await seedOrder({ ...changed, updatedAt: clock.toISOString() });
    await seedOrder({
      ...erp,
      updatedAt: clock.toISOString(),
      lines: changed.lines,
    });
    expect((await orders.get(context(), id))?.order).toMatchObject({
      differs: false,
      comparisonState: 'matching',
    });
  });

  it('compares current units, ignores removed SKU groups and keeps earlier snapshots immutable', async () => {
    const source = {
      connectionId: shopify,
      external: 'edit-1',
      key: 'edited',
      updatedAt: '2026-09-19T08:00:00Z',
      data: {},
      lines: [
        {
          external: 'edit-line',
          key: 'edit-line',
          quantity: '2',
          current: '2',
          sku: { external: 'item-1', key: 'edit-sku' },
          unitPrice: '0.1',
        },
      ],
    };
    const id = await seedOrder(source);
    const before = (await services.orders.current(context(), id))[0]!.snapshot;
    await seedOrder({
      ...source,
      connectionId: jtl,
      external: 'erp-edit-1',
      lines: [
        {
          external: 'erp-line',
          key: 'erp-line',
          quantity: '2',
          cancelled: null,
          unitPrice: '0.1',
          sku: { external: 'erp-item', key: 'edit-sku' },
        },
      ],
    });
    expect((await workspace().get(context(), id))?.differences).toEqual([]);
    await seedOrder({
      ...source,
      updatedAt: '2026-09-19T09:00:00Z',
      lines: [{ ...source.lines[0]!, current: '1', cancelled: '1' }],
    });
    const edited = (await workspace().get(context(), id))!;
    expect(
      edited.sources.find((s) => s.connectionId === shopify)?.lines[0],
    ).toMatchObject({
      quantity: '2',
      currentQuantity: '1',
      cancelledQuantity: '1',
      remainingQuantity: '1',
      currentTotal: { amount: '0.1', currency: 'EUR' },
    });
    // ERP reductions are unknown; ordered units cannot substitute for current units.
    expect(edited.differences).toEqual([]);
    expect(edited.order.comparisonState).toBe('inconclusive');
    expect(
      edited.sources.find((s) => s.connectionId === jtl)?.lines[0],
    ).toMatchObject({
      currentQuantity: null,
      cancelledQuantity: null,
      remainingQuantity: null,
      // Without current units, Luma can't know the line's value.
      currentTotal: null,
    });
    expect(
      (await services.orders.history(context(), id)).find(
        (s) => s.observationId === before.observationId,
      ),
    ).toEqual(before);
    await seedOrder({
      ...source,
      updatedAt: '2026-09-19T10:00:00Z',
      lines: [{ ...source.lines[0]!, current: '0', cancelled: '2' }],
    });
    await seedOrder({
      ...source,
      connectionId: jtl,
      external: 'erp-edit-1',
      updatedAt: '2026-09-19T10:00:00Z',
      lines: [],
    });
    expect((await workspace().get(context(), id))?.differences).toEqual([]);
    expect(
      (await workspace().get(context(), id))?.sources.find(
        (s) => s.connectionId === shopify,
      ),
    ).toMatchObject({ open: false, fulfillment: 'not_required' });
  });

  it('counts shipment evidence once and keeps remaining units nonnegative after a refund', async () => {
    const source = {
      connectionId: shopify,
      external: 'work-1',
      key: 'work-1',
      updatedAt: '2026-09-19T08:00:00Z',
      data: {},
      lines: [
        {
          external: 'work-line',
          key: 'work-line',
          quantity: '2',
          current: '2',
        },
      ],
    };
    const id = await seedOrder(source);
    await seedShipment({
      connectionId: shopify,
      order: source.external,
      external: 'closed-work',
      line: 'work-line',
      quantity: '2',
      remaining: '0',
      status: 'completed',
      kind: 'fulfillment_order',
    });
    await seedShipment({
      connectionId: shopify,
      order: source.external,
      external: 'actual-shipment',
      line: 'work-line',
      quantity: '1',
      status: 'shipped',
      kind: 'shipment',
    });
    expect(
      (await workspace().get(context(), id))?.sources[0]?.lines[0],
    ).toMatchObject({ fulfilledQuantity: '1', remainingQuantity: '1' });
    await seedOrder({
      ...source,
      updatedAt: '2026-09-19T11:00:00Z',
      lines: [{ ...source.lines[0]!, current: '0', cancelled: '2' }],
    });
    expect(
      (await workspace().get(context(), id))?.sources[0]?.lines[0],
    ).toMatchObject({ fulfilledQuantity: '1', remainingQuantity: '0' });
  });
  it('plans an order change from fresh fulfilment evidence, within one tenant and with the reader’s access', async () => {
    const read = '2026-09-20T11:58:00Z';
    clock = new Date('2026-09-20T12:00:00Z');
    const tote = {
      external: 'gid://shopify/InventoryItem/41',
      key: 'plan-tote',
    };
    const id = await seedOrder({
      connectionId: shopify,
      external: 'gid://shopify/Order/2001',
      key: 'plan-order',
      updatedAt: read,
      data: { displayNumber: '#2001' },
      lines: [
        {
          external: 'gid://shopify/LineItem/21',
          key: 'plan-line-shop',
          quantity: '3',
          current: '3',
          sku: tote,
          skuCode: 'TOTE-NAT',
        },
      ],
    });
    await seedOrder({
      connectionId: jtl,
      external: 'jtl-order-20',
      key: 'plan-order',
      updatedAt: read,
      data: { displayNumber: 'SO-20' },
      lines: [
        {
          external: '201',
          key: 'plan-line-jtl',
          quantity: '3',
          current: '3',
          sku: { external: 'jtl-item-41', key: 'plan-tote' },
          skuCode: 'TOTE-NAT',
        },
      ],
    });
    const skuId = (await workspace().get(context(), id))!.sources[0]!.lines[0]!
      .comparisonKey!;
    await owner.query(
      "INSERT INTO organizations(data_region,id,name,slug,status,created_at,write_mode) VALUES('AU',$1,'Plan',$2,'active',now(),'writes_enabled') ON CONFLICT (id) DO UPDATE SET write_mode='writes_enabled'",
      [tenant, `plan-${tenant}`],
    );
    const grants = ['orders.read', 'fulfillment.read', 'inventory.read'];
    const grant = (capabilities: string[]) =>
      owner.query(
        "UPDATE connector_installations SET document=document || jsonb_build_object('permissions',$3::jsonb,'granted',$3::jsonb) WHERE tenant_id=$1 AND id=$2",
        [tenant, shopify, JSON.stringify(capabilities)],
      );
    await grant([...grants, 'orders.quantity.edit']);
    try {
      const plans = workspace((app, capability) =>
        app === 'shopify' && capability === 'orders.quantity.edit'
          ? 'shopify:order_edits.apply'
          : null,
      );
      const request = {
        kind: 'quantity' as const,
        lineKey: skuId,
        quantity: '1',
      };
      // Before picking, Luma can reduce the Shopify line; JTL is updated by a person.
      const before = (await plans.changePlan(context(), id, request))!;
      expect(before.hidden).toEqual([]);
      expect(before.plans[0]!.safety).toEqual({ state: 'safe', reasons: [] });
      expect(before.plans[0]!.steps).toMatchObject([
        {
          performer: 'luma',
          connectionId: shopify,
          capability: 'orders.quantity.edit',
          executable: true,
          permission: 'shopify:order_edits.apply',
          viewerCanRequest: true,
          handoff: {
            orderExternalId: 'gid://shopify/Order/2001',
            lines: [{ externalId: 'gid://shopify/LineItem/21', quantity: '1' }],
          },
        },
        { performer: 'person', role: 'operator', connectionId: jtl },
      ]);

      // A member may read the plan, but lacks the app permission to request the Luma step.
      const member = makeTenantContext(
        { userId: 'member', sessionId: 'session' },
        {
          id: tenant,
          name: 'Fixture',
          slug: 'fixture',
          status: 'active',
          dataRegion: 'AU',
        },
        builtInMembership(
          { id: 'm-member', organizationId: tenant, userId: 'member' },
          'member',
        ),
        randomUUID(),
      );
      expect(
        (await plans.changePlan(member, id, request))!.plans[0]!.steps[0],
      ).toMatchObject({ executable: true, viewerCanRequest: false });
      // Without fulfilment access the plan says so and is never safe.
      const ordersOnly = {
        ...builtInMembership(
          { id: 'm-orders', organizationId: tenant, userId: 'orders' },
          'member',
        ),
        permissions: new PermissionSet(['orders.read']),
      };
      const restricted = (await plans.changePlan(
        makeTenantContext(
          { userId: 'orders', sessionId: 'session' },
          {
            id: tenant,
            name: 'Fixture',
            slug: 'fixture',
            status: 'active',
            dataRegion: 'AU',
          },
          ordersOnly,
          randomUUID(),
        ),
        id,
        request,
      ))!;
      expect(restricted.hidden).toEqual(['fulfillments']);
      expect(restricted.plans[0]!.shipped).toEqual([]);
      expect(restricted.plans[0]!.safety).toMatchObject({ state: 'unknown' });
      expect(
        restricted.plans[0]!.safety.reasons.map((reason) => reason.code),
      ).toContain('fulfilment_hidden');
      // Another tenant cannot plan this order, and a foreign line is refused.
      expect(
        await plans.changePlan(context(otherTenant), id, request),
      ).toBeNull();
      await expect(
        plans.changePlan(context(), id, { ...request, lineKey: randomUUID() }),
      ).rejects.toMatchObject({ statusCode: 422 });

      // Apps read another source's stored quantities for the store's lines, matched by SKU.
      const lines = await createSourceOrderLines(createTenantDatabase(reader), {
        state: orderStateQueries,
      })(context(), {
        connectionId: shopify,
        orderId: 'gid://shopify/Order/2001',
        sourceConnectionId: jtl,
      });
      expect(lines).toMatchObject({
        connectionId: jtl,
        observedAt: new Date(read).toISOString(),
        complete: true,
        lines: [{ externalId: 'gid://shopify/LineItem/21', quantity: '3' }],
      });
      const sourceLines = createSourceOrderLines(createTenantDatabase(reader), {
        state: orderStateQueries,
      });
      const lineInput = {
        connectionId: shopify,
        orderId: 'gid://shopify/Order/2001',
        sourceConnectionId: jtl,
      };
      const recordRead = createOrderReadChecks(createTenantDatabase(writer));
      // A failed point refresh must withhold propagation even while stored quantities are recent.
      await recordRead(
        context(),
        jtl,
        { externalId: 'jtl-order-20', scopeKey: '' },
        'orders.read',
        {
          observedAt: new Date(Date.parse(read) + 1000).toISOString(),
          complete: false,
          observationIds: [],
        },
      );
      expect(await sourceLines(context(), lineInput)).toMatchObject({
        complete: false,
      });
      await recordRead(
        context(),
        jtl,
        { externalId: 'jtl-order-20', scopeKey: '' },
        'orders.read',
        {
          observedAt: new Date(Date.parse(read) + 2000).toISOString(),
          complete: true,
          observationIds: [lines!.observationId],
        },
      );
      expect(await sourceLines(context(), lineInput)).toMatchObject({
        complete: true,
      });
      expect(
        await createSourceOrderLines(createTenantDatabase(reader), {
          state: orderStateQueries,
        })(context(otherTenant), {
          connectionId: shopify,
          orderId: 'gid://shopify/Order/2001',
          sourceConnectionId: jtl,
        }),
      ).toBeNull();

      // JTL created a delivery note: picking started, so the warehouse step goes to a person.
      await seedShipment({
        connectionId: jtl,
        order: 'jtl-order-20',
        external: 'jtl-note-20',
        line: '201',
        quantity: '3',
        status: 'processing',
        kind: 'shipment',
        observedAt: '2026-09-20T11:59:00Z',
      });
      const after = (await plans.changePlan(context(), id, request))!.plans[0]!;
      expect(after.safety).toEqual({
        state: 'unsafe',
        reasons: [{ code: 'work_started', connectionId: jtl, lineKey: skuId }],
      });
      expect(after.steps.map((step) => [step.action, step.role])).toEqual([
        ['confirm_picking', 'warehouse'],
        ['update_quantity', null],
        ['update_quantity', 'operator'],
        ['escalate_unsafe', 'operator'],
      ]);
      expect(after.steps[1]).toMatchObject({
        performer: 'luma',
        executable: false,
        blockedBy: 'unsafe',
      });

      // Ten minutes without a reread make the evidence stale; the plan is unknown, not safe.
      clock = new Date('2026-09-20T12:10:00Z');
      const stale = (await plans.changePlan(context(), id, {
        ...request,
        quantity: '5',
      }))!.plans[0]!;
      expect(stale.safety.state).toBe('unknown');
      expect(stale.safety.reasons.map((reason) => reason.code)).toContain(
        'stale_evidence',
      );
      expect(stale.steps.some((step) => step.executable)).toBe(false);

      // Observe-only blocks the Luma step even when the change is safe.
      clock = new Date('2026-09-20T12:00:00Z');
      await owner.query(
        "UPDATE organizations SET write_mode='observe_only' WHERE id=$1",
        [tenant],
      );
      expect(
        (await plans.changePlan(context(), id, { ...request, quantity: '4' }))!
          .plans[0]!.steps[0],
      ).toMatchObject({ executable: false, blockedBy: 'observe_only' });
    } finally {
      await grant(grants);
    }
  });
  it('filters and sorts the list by custom order fields the reader may read', async () => {
    await owner.query(
      "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Adaptive',$2,'active',now()) ON CONFLICT DO NOTHING",
      [tenant, `adaptive-${tenant}`],
    );
    const field = async (type: string, readPermission = 'orders.read') => {
      const id = randomUUID();
      await owner.query(
        'INSERT INTO adaptive_fields(tenant_id,id,record_type,field_key,field_type,archived,source,document,created_at) VALUES($1,$2,$3,$4,$5,false,$6,$7,$8)',
        [
          tenant,
          id,
          'order',
          `f_${id.replaceAll('-', '')}`,
          type,
          'luma',
          {
            id,
            recordType: 'order',
            key: `f_${id.replaceAll('-', '')}`,
            type,
            label: { en: 'Field', de: 'Feld' },
            choices: [],
            readPermission,
            writePermission: 'sales.manage',
            revision: 1,
            archived: false,
            source: 'luma',
            createdAt: clock.toISOString(),
            updatedAt: clock.toISOString(),
          },
          clock,
        ],
      );

      return id;
    };
    const priority = await field('number');
    const labels = await field('multi_choice');
    // No role grants this permission, so even an owner cannot read the field.
    const secret = await field('text', 'restricted.fields.read');
    const value = (record: string, id: string, stored: unknown) =>
      owner.query(
        'INSERT INTO adaptive_field_values(tenant_id,record_type,record_id,field_id,value,document) VALUES($1,$2,$3,$4,$5,$6)',
        [
          tenant,
          'order',
          record,
          id,
          JSON.stringify(stored),
          { fieldId: id, value: stored },
        ],
      );
    const ids: string[] = [];
    for (const [number, rank, tags] of [
      ['P1', 3, ['vip']],
      ['P2', 1, []],
      ['P3', null, ['vip', 'rush']],
    ] as const) {
      const id = await seedOrder({
        connectionId: shopify,
        external: `custom-${number}`,
        key: `custom-${number}`,
        updatedAt: '2026-09-19T10:00:00Z',
        data: { displayNumber: number },
        lines: [],
      });
      ids.push(id);
      if (rank !== null) await value(id, priority, rank);
      await value(id, labels, tags);
    }
    const [p1, p2, p3] = ids;
    const orders = workspace();

    type Query = Parameters<typeof orders.list>[1];

    const list = (query: Partial<Query>) =>
      orders.list(context(), {
        q: '',
        view: 'all',
        sort: 'updated',
        direction: 'desc',
        limit: 50,
        ...query,
      });
    const where = (
      conditions: NonNullable<Query['where']>['conditions'],
    ): Partial<Query> => ({ where: { match: 'all', conditions } });
    const numbers = async (query: Partial<Query>) =>
      (await list(query)).items.map((item) => item.id);

    expect(
      await numbers(
        where([{ field: `custom:${priority}`, op: 'gte', value: 2 }]),
      ),
    ).toEqual([p1]);
    // A missing value is empty, never zero.
    expect(
      await numbers(
        where([{ field: `custom:${priority}`, op: 'lte', value: 0 }]),
      ),
    ).toEqual([]);
    expect(
      (
        await numbers(
          where([{ field: `custom:${labels}`, op: 'any_of', value: ['vip'] }]),
        )
      ).sort(),
    ).toEqual([p1, p3].sort());
    const sorted = await numbers({
      ...where([{ field: `custom:${labels}`, op: 'not_empty' }]),
      sort: `custom:${priority}`,
      direction: 'asc',
    });
    // Rows without a value sort last in both directions.
    expect(sorted).toEqual([p1, p3]);
    expect(
      await numbers({
        sort: `custom:${priority}`,
        direction: 'desc',
        ...where([{ field: `custom:${priority}`, op: 'not_empty' }]),
      }),
    ).toEqual([p1, p2]);
    await expect(
      list(where([{ field: `custom:${secret}`, op: 'is', value: 'x' }])),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      list(where([{ field: `custom:${randomUUID()}`, op: 'empty' }])),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(list({ sort: `custom:${labels}` })).rejects.toMatchObject({
      statusCode: 400,
    });
  }, 60000);

  it('filters and sorts customers by custom customer fields the reader may read, within one tenant', async () => {
    await owner.query(
      "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Adaptive',$2,'active',now()) ON CONFLICT DO NOTHING",
      [tenant, `adaptive-${tenant}`],
    );
    await owner.query('DELETE FROM customer_profiles WHERE tenant_id=$1', [
      tenant,
    ]);
    const field = async (
      type: string,
      readPermission = 'customers.read',
      recordType = 'customer',
    ) => {
      const id = randomUUID();
      const key = `f_${id.replaceAll('-', '')}`;
      await owner.query(
        'INSERT INTO adaptive_fields(tenant_id,id,record_type,field_key,field_type,archived,source,document,created_at) VALUES($1,$2,$3,$4,$5,false,$6,$7,$8)',
        [
          tenant,
          id,
          recordType,
          key,
          type,
          'luma',
          {
            id,
            recordType,
            key,
            type,
            label: { en: 'Field', de: 'Feld' },
            choices: [],
            readPermission,
            writePermission: 'customers.read',
            revision: 1,
            archived: false,
            source: 'luma',
            createdAt: clock.toISOString(),
            updatedAt: clock.toISOString(),
          },
          clock,
        ],
      );

      return id;
    };
    const tier = await field('single_choice');
    const visits = await field('number');
    // No role grants this permission, so even an owner cannot read the field.
    const secret = await field('text', 'restricted.fields.read');
    // An order field with the same shape never applies to customers.
    const orderField = await field('number', 'orders.read', 'order');
    const value = (record: string, id: string, stored: unknown) =>
      owner.query(
        'INSERT INTO adaptive_field_values(tenant_id,record_type,record_id,field_id,value,document) VALUES($1,$2,$3,$4,$5,$6)',
        [
          tenant,
          'customer',
          record,
          id,
          JSON.stringify(stored),
          { fieldId: id, value: stored },
        ],
      );
    const ids: string[] = [];
    for (const [name, level, count] of [
      ['Wholesale Ada', 'wholesale', 3],
      ['Retail Ben', 'retail', 1],
      ['Unrated Cy', null, null],
    ] as const) {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,display_name,state,
          contact_shared,address_shared,observed_at,observation_id)
         VALUES($1,$2,$3,$4,$5,'enabled',true,false,now(),gen_random_uuid())`,
        [tenant, shopify, `custom-${name}`, id, name],
      );
      ids.push(id);
      if (level !== null) await value(id, tier, level);
      if (count !== null) await value(id, visits, count);
    }
    const [ada, ben, cy] = ids;
    const customers = createCustomerWorkspace(createTenantDatabase(reader));

    type Query = Parameters<typeof customers.list>[1];

    const list = (query: Partial<Query>, tenantId = tenant) =>
      customers.list(context(tenantId), {
        q: '',
        sort: 'created',
        direction: 'desc',
        limit: 50,
        ...query,
      });
    const where = (
      conditions: NonNullable<Query['where']>['conditions'],
    ): Partial<Query> => ({ where: { match: 'all', conditions } });
    const found = async (query: Partial<Query>) =>
      (await list(query)).items.map((item) => item.id);

    expect(
      await found(
        where([
          { field: `custom:${tier}`, op: 'any_of', value: ['wholesale'] },
        ]),
      ),
    ).toEqual([ada]);
    // A customer without a value is empty, never a match for a value.
    expect(
      await found(where([{ field: `custom:${tier}`, op: 'empty' }])),
    ).toEqual([cy]);
    expect(
      await found(where([{ field: `custom:${visits}`, op: 'gte', value: 2 }])),
    ).toEqual([ada]);
    // Customers without a value sort last in both directions, and the cursor keeps the sort.
    expect(await found({ sort: `custom:${visits}`, direction: 'asc' })).toEqual(
      [ben, ada, cy],
    );
    const first = await list({
      sort: `custom:${visits}`,
      direction: 'desc',
      limit: 1,
    });
    expect(first.items.map((item) => item.id)).toEqual([ada]);
    expect(
      await found({
        sort: `custom:${visits}`,
        direction: 'desc',
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      }),
    ).toEqual([ben]);
    // The other workspace has no such field.
    await expect(
      list(where([{ field: `custom:${tier}`, op: 'empty' }]), otherTenant),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      list(where([{ field: `custom:${secret}`, op: 'is', value: 'x' }])),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      list(where([{ field: `custom:${orderField}`, op: 'empty' }])),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      list(where([{ field: `custom:${randomUUID()}`, op: 'empty' }])),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(list({ sort: `custom:${secret}` })).rejects.toMatchObject({
      statusCode: 403,
    });
  }, 60000);

  it('applies saved-view custom filters and ordering before native pagination and denies unavailable fields', async () => {
    await owner.query(
      "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Adaptive',$2,'active',now()) ON CONFLICT DO NOTHING",
      [tenant, `adaptive-${tenant}`],
    );
    const fieldId = randomUUID();
    const field = {
      id: fieldId,
      recordType: 'order',
      key: `urgency_${fieldId.replaceAll('-', '')}`,
      type: 'number',
      label: { en: 'Urgency', de: 'Dringlichkeit' },
      choices: [],
      readPermission: 'orders.read',
      writePermission: 'sales.manage',
      revision: 1,
      archived: false,
      source: 'luma',
      createdAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    };
    await owner.query(
      'INSERT INTO adaptive_fields(tenant_id,id,record_type,field_key,field_type,archived,source,document,created_at) VALUES($1,$2,$3,$4,$5,false,$6,$7,$8)',
      [tenant, fieldId, 'order', field.key, 'number', 'luma', field, clock],
    );
    const ids = [];
    for (const [number, urgency, status] of [
      ['A', 20, 'open'],
      ['B', 10, 'open'],
      ['C', 100, 'cancelled'],
    ] as const) {
      const id = await seedOrder({
        connectionId: shopify,
        external: `adaptive-${number}`,
        key: `adaptive-${number}`,
        updatedAt: '2026-09-19T10:00:00Z',
        data: { displayNumber: number, status },
        lines: [],
      });
      ids.push(id);
      await owner.query(
        'INSERT INTO adaptive_field_values(tenant_id,record_type,record_id,field_id,value,document) VALUES($1,$2,$3,$4,$5,$6)',
        [
          tenant,
          'order',
          id,
          fieldId,
          JSON.stringify(urgency),
          { fieldId, value: urgency },
        ],
      );
    }
    const query = {
      q: '',
      count: 'exact' as const,
      view: 'all' as const,
      status: 'open',
      sort: 'updated' as const,
      direction: 'desc' as const,
      limit: 1,
      adaptive: {
        filters: [{ fieldId, operator: 'gte' as const, value: 10 }],
        sort: { fieldId, direction: 'desc' as const },
      },
    };
    const first = await workspace().list(context(), query);
    expect(first.items.map((item) => item.displayNumber)).toEqual(['A']);
    expect(first.totalCount).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await workspace().list(context(), {
      ...query,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.displayNumber)).toEqual(['B']);
    expect(second.nextCursor).toBeNull();
    await expect(
      workspace().list(context(otherTenant), {
        ...query,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const selected = await workspace().list(context(), {
      ...query,
      adaptive: { ...query.adaptive, selectedRecordIds: [ids[2]!] },
    });
    expect(selected.items).toHaveLength(0);
    await owner.query(
      "UPDATE adaptive_fields SET archived=true,document=jsonb_set(document,'{archived}','true') WHERE tenant_id=$1 AND id=$2",
      [tenant, fieldId],
    );
    await expect(workspace().list(context(), query)).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it('queries custom order filters and sorting over 100,000 native projections without page sampling', async () => {
    await owner.query(
      "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Adaptive',$2,'active',now()) ON CONFLICT DO NOTHING",
      [tenant, `adaptive-${tenant}`],
    );
    const original = await seedOrder({
      connectionId: shopify,
      external: 'adaptive-template',
      key: 'adaptive-template',
      updatedAt: '2026-09-19T10:00:00Z',
      data: { displayNumber: 'template' },
      lines: [],
    });
    const fieldId = randomUUID();
    const field = {
      id: fieldId,
      recordType: 'order',
      key: `urgency_${fieldId.replaceAll('-', '')}`,
      type: 'number',
      label: { en: 'Urgency', de: 'Dringlichkeit' },
      choices: [],
      readPermission: 'orders.read',
      writePermission: 'sales.manage',
      revision: 1,
      archived: false,
      source: 'luma',
      createdAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    };
    await owner.query(
      'INSERT INTO adaptive_fields(tenant_id,id,record_type,field_key,field_type,archived,source,document,created_at) VALUES($1,$2,$3,$4,$5,false,$6,$7,$8)',
      [tenant, fieldId, 'order', field.key, 'number', 'luma', field, clock],
    );
    const seed = await owner.connect();
    try {
      // Bulk performance fixtures already supply maintained projections; avoid replaying ingestion triggers.
      await seed.query('SET session_replication_role=replica');
      await seed.query(
        'CREATE TEMP TABLE adaptive_perf_ids AS SELECT gen_random_uuid() AS entity_id,gen_random_uuid() AS snapshot_id,n FROM generate_series(1,100000) n',
      );
      await seed.query(
        "INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key) SELECT entity_id,$1,'order','adaptive-perf-'||n FROM adaptive_perf_ids",
        [tenant],
      );
      await seed.query(
        `INSERT INTO orders_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,mapping_version,source_updated_at,observed_at,document)
        SELECT i.snapshot_id,s.tenant_id,i.entity_id,s.kind,s.connection_id,s.observation_id,s.normalizer_version,s.mapping_version,s.source_updated_at,s.observed_at,jsonb_set(s.document,'{entityId}',to_jsonb(i.entity_id::text))
        FROM adaptive_perf_ids i CROSS JOIN orders_snapshots s WHERE s.tenant_id=$1 AND s.entity_id=$2 AND s.connection_id=$3`,
        [tenant, original, shopify],
      );
      await seed.query(
        `INSERT INTO orders_projections(tenant_id,entity_id,connection_id,snapshot_id) SELECT $1,entity_id,$2,snapshot_id FROM adaptive_perf_ids`,
        [tenant, shopify],
      );
      await seed.query(
        `INSERT INTO orders_list(tenant_id,entity_id,connection_id,snapshot_id,selected,status,payment_status,display_number,observed_at,source_updated_at,placed_at,due_at,deleted,line_count,fulfillment,open,state_valid_from,differs,updated_key,placed_key,placed_rank,number_key,number_rank,due_key,due_rank,updated_rank)
       SELECT s.tenant_id,i.entity_id,s.connection_id,i.snapshot_id,true,CASE WHEN i.n%2=0 THEN 'open' ELSE 'cancelled' END,s.payment_status,'perf-'||i.n,s.observed_at,s.source_updated_at,s.placed_at,s.due_at,false,s.line_count,s.fulfillment,s.open,s.state_valid_from,false,s.updated_key,s.placed_key,s.placed_rank,'perf-'||i.n,0,s.due_key,s.due_rank,s.updated_rank FROM adaptive_perf_ids i CROSS JOIN orders_list s WHERE s.tenant_id=$1 AND s.entity_id=$2 AND s.connection_id=$3`,
        [tenant, original, shopify],
      );
      await seed.query(
        `INSERT INTO adaptive_field_values(tenant_id,record_type,record_id,field_id,value,document) SELECT $1,'order',entity_id,$2,to_jsonb(n%100),jsonb_build_object('fieldId',$2::uuid::text,'value',n%100) FROM adaptive_perf_ids`,
        [tenant, fieldId],
      );
      await seed.query('ANALYZE orders_list');
      await seed.query('ANALYZE adaptive_field_values');
    } finally {
      await seed.query('SET session_replication_role=origin');
      await seed.query('DROP TABLE adaptive_perf_ids');
      seed.release();
    }
    const started = performance.now();
    const result = await workspace().list(context(), {
      q: '',
      view: 'all',
      status: 'open',
      sort: 'updated',
      direction: 'desc',
      limit: 50,
      count: 'exact',
      adaptive: {
        filters: [{ fieldId, operator: 'gte', value: 90 }],
        sort: { fieldId, direction: 'desc' },
      },
    });
    const elapsed = performance.now() - started;
    expect(result.totalCount).toBe(5000);
    expect(result.items).toHaveLength(50);
    expect(result.nextCursor).not.toBeNull();
    const values = await owner.query<{ value: number }>(
      'SELECT value FROM adaptive_field_values WHERE tenant_id=$1 AND field_id=$2 AND record_id=ANY($3::uuid[])',
      [tenant, fieldId, result.items.map((item) => item.id)],
    );
    expect(values.rows.every((row) => row.value === 98)).toBe(true);
    process.stdout.write(
      `Adaptive native order query: 100,000 records, ${elapsed.toFixed(1)} ms\n`,
    );
  }, 120000);

  it('groups and charts the complete filtered custom-field query and refuses inaccessible fields', async () => {
    await owner.query(
      "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Adaptive',$2,'active',now()) ON CONFLICT DO NOTHING",
      [tenant, `adaptive-${tenant}`],
    );
    const fieldId = randomUUID();
    const field = {
      id: fieldId,
      recordType: 'order',
      key: `board_${fieldId.replaceAll('-', '')}`,
      type: 'number',
      label: { en: 'Priority', de: 'Priorität' },
      choices: [],
      readPermission: 'sales.manage',
      writePermission: 'sales.manage',
      revision: 1,
      archived: false,
      source: 'luma',
      createdAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    };
    await owner.query(
      'INSERT INTO adaptive_fields(tenant_id,id,record_type,field_key,field_type,archived,source,document,created_at) VALUES($1,$2,$3,$4,$5,false,$6,$7,$8)',
      [tenant, fieldId, 'order', field.key, 'number', 'luma', field, clock],
    );
    for (const [number, priority] of [
      ['A', 1],
      ['B', 2],
      ['C', 2],
    ] as const) {
      const id = await seedOrder({
        connectionId: shopify,
        external: `board-${number}`,
        key: `board-${number}`,
        updatedAt: '2026-09-19T10:00:00Z',
        data: { displayNumber: number },
        lines: [],
      });
      await owner.query(
        'INSERT INTO adaptive_field_values(tenant_id,record_type,record_id,field_id,value,document) VALUES($1,$2,$3,$4,$5,$6)',
        [
          tenant,
          'order',
          id,
          fieldId,
          JSON.stringify(priority),
          { fieldId, value: priority },
        ],
      );
    }
    const adapter = createAdaptiveViewReadAdapter(
      createTenantDatabase(reader),
      {
        read: async (c, filters) => {
          const result = await workspace().list(
            c,
            orderListQuerySchema.parse(filters),
          );

          return {
            ...result,
            items: result.items.map((item) => ({ ...item })),
          };
        },
      },
      { recordType: 'order', columns: ['id', 'displayNumber', 'status'] },
    );
    const query = adaptiveViewQueryV1Schema.parse({
      version: 1,
      domain: 'orders',
      filters: { status: 'open' },
      columns: ['displayNumber', `custom:${fieldId}`],
      customFilters: [{ fieldId, operator: 'gte', value: 2 }],
      sort: { field: `custom:${fieldId}`, direction: 'desc' },
      groupBy: `custom:${fieldId}`,
      metrics: [{ id: 'count', operation: 'count', field: null }],
      charts: [
        {
          id: 'priorities',
          type: 'bar',
          groupBy: `custom:${fieldId}`,
          metricId: 'count',
        },
      ],
    });
    const result = await adapter.read(
      context(),
      { q: '', view: 'all', status: 'open' },
      query,
    );
    expect(result.totalCount).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.aggregates).toEqual([
      { metricId: 'count', value: 2, complete: true },
    ]);
    expect(result.groups).toEqual([{ key: 2, count: 2 }]);
    expect(result.chartSeries).toEqual([
      {
        id: 'priorities',
        points: [{ key: 2, value: 2, count: 2 }],
        truncated: false,
        complete: true,
      },
    ]);
    const limited = makeTenantContext(
      { userId: 'operator', sessionId: 'session' },
      {
        id: tenant,
        name: 'Fixture',
        slug: 'fixture',
        status: 'active',
        dataRegion: 'AU',
      },
      {
        ...builtInMembership(
          { id: 'membership', organizationId: tenant, userId: 'operator' },
          'member',
        ),
        permissions: new PermissionSet(['orders.read']),
      },
      randomUUID(),
    );
    await expect(
      adapter.read(limited, { q: '', view: 'all', status: 'open' }, query),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
  it('selects warehouse stock delays only from explicit fresh source holds', async () => {
    const orderId = await seedOrder({
      connectionId: shopify,
      external: 'stock-held-order',
      key: 'stock-held-order',
      updatedAt: clock.toISOString(),
      data: { displayNumber: 'HELD' },
      lines: [{ external: 'held-line', key: 'held-line', quantity: '1' }],
    });
    await seedShipment({
      connectionId: shopify,
      external: 'held-fulfillment',
      order: 'stock-held-order',
      line: 'held-line',
      quantity: '1',
      status: 'processing',
      kind: 'fulfillment_order',
      remaining: '1',
      observedAt: clock.toISOString(),
      holds: [{ reason: 'inventory_out_of_stock' }],
      location: {
        id: { externalId: 'de-warehouse', scopeKey: '' },
        name: 'German warehouse',
      },
    });
    const location = (
      await owner.query<{ id: string }>(
        "SELECT id FROM inventory_entities WHERE tenant_id=$1 AND kind='location' AND reconciliation_key='German warehouse'",
        [tenant],
      )
    ).rows[0]!.id;
    const query = {
      q: '',
      view: 'all' as const,
      sort: 'updated' as const,
      direction: 'desc' as const,
      limit: 50,
      count: 'exact' as const,
      stockBlocked: true as const,
      locationId: location,
    };
    const selected = await workspace().list(context(), query);
    expect(selected.items.map((item) => item.id)).toEqual([orderId]);
    expect(selected.totalCount).toBe(1);
    expect(
      (
        await workspace().list(context(), {
          ...query,
          locationId: randomUUID(),
        })
      ).items,
    ).toHaveLength(0);
    clock = new Date(clock.getTime() + 6 * 60000);
    expect((await workspace().list(context(), query)).items).toHaveLength(0);
    const limited = makeTenantContext(
      { userId: 'operator', sessionId: 'session' },
      {
        id: tenant,
        name: 'Fixture',
        slug: 'fixture',
        status: 'active',
        dataRegion: 'AU',
      },
      {
        ...builtInMembership(
          { id: 'membership', organizationId: tenant, userId: 'operator' },
          'member',
        ),
        permissions: new PermissionSet(['orders.read']),
      },
      randomUUID(),
    );
    await expect(workspace().list(limited, query)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it('persists private saved-view revisions under the restricted tenant role with replay and archive restore', async () => {
    await owner.query(
      "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Adaptive',$2,'active',now()) ON CONFLICT DO NOTHING",
      [tenant, `adaptive-${tenant}`],
    );
    const userId = randomUUID();
    const actor = (tenantId: string, user: string = userId) =>
      makeTenantContext(
        { userId: user, sessionId: randomUUID() },
        {
          id: tenantId,
          name: 'Fixture',
          slug: 'fixture',
          status: 'active',
          dataRegion: 'AU',
        },
        builtInMembership(
          { id: randomUUID(), organizationId: tenantId, userId: user },
          'member',
        ),
        randomUUID(),
      );
    const service = createAdaptiveViews(createTenantDatabase(reader), {
      refreshContext: async (c) => c,
      released: async () => true,
      readers: {
        orders: {
          read: async () => ({
            items: [],
            nextCursor: null,
            asOf: clock.toISOString(),
          }),
        },
      },
      trace: (c) => ({
        traceId: 'trace',
        spanId: 'span',
        requestId: c.requestId,
      }),
    });
    const form = {
      commandId: randomUUID(),
      name: 'Orders requiring review',
      description: '',
      sharing: { scope: 'private' as const, roleIds: [] },
      query: adaptiveViewQueryV1Schema.parse({
        version: 1,
        domain: 'orders',
        filters: { status: 'open' },
        columns: ['displayNumber', 'status'],
      }),
      reviewed: true as const,
    };
    const saved = await service.create(actor(tenant), form);
    expect((await service.create(actor(tenant), form)).id).toBe(saved.id);
    expect((await service.list(actor(tenant))).items).toHaveLength(1);
    await expect(
      service.get(actor(otherTenant), saved.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.get(actor(tenant, randomUUID()), saved.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    const updated = await service.update(actor(tenant), saved.id, {
      ...form,
      name: 'Revised',
      expectedRevision: 1,
    });
    expect(updated.revision).toBe(2);
    await expect(
      service.update(actor(tenant), saved.id, { ...form, expectedRevision: 1 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await service.history(actor(tenant), saved.id)).items.map(
        (item) => item.revision,
      ),
    ).toEqual([2, 1]);
    const archived = await service.archive(actor(tenant), saved.id, 2);
    expect((await service.list(actor(tenant))).items).toHaveLength(0);
    const restored = await service.restore(
      actor(tenant),
      saved.id,
      archived.revision,
    );
    expect(restored.name).toBe('Revised');
    expect(restored.archived).toBe(false);
    expect(restored.revision).toBe(4);
  });
});
