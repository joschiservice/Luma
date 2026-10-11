import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { buildApp, createCommerceServices } from '@luma/application-runtime';
import {
  assistantModelProfile,
  createWorkspaceAssistant,
} from '@luma/assistant/composition';
import type { CommerceObservation } from '@luma/connections';
import {
  createConnectionCoverage,
  createSourceAuthority,
} from '@luma/connections/composition';
import {
  orderAttentionForOrders,
  orderAttentionQuery,
} from '@luma/exceptions/composition';
import type { IdentityService } from '@luma/identity';
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
  createOperationalMetrics,
  createOrderWorkspace,
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
        dataRegion: 'EU',
      },
      builtInMembership(
        { id: 'membership', organizationId: tenantId, userId: 'operator' },
        'owner',
      ),
      randomUUID(),
    );
  }

  function workspace() {
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
        observedAt: '2026-09-19T10:00:00Z',
        sourceUpdatedAt: '2026-09-19T10:00:00Z',
        sourceRevision: null,
        adapterVersion: 'fixture/1',
        schemaVersion: 1,
        data: {
          order: { externalId: options.order, scopeKey: '' },
          status: options.status,
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
    const password = randomUUID();
    // The writer mirrors the ingestion worker; the reader mirrors the API login.
    for (const [role, grants] of [
      [`${name}_w`, 'luma_connectors,luma_orders,luma_inventory'],
      [`${name}_r`, 'luma_connectors,luma_case_reader,luma_desk'],
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
      'TRUNCATE connector_authority_settings,connector_authority_events,connector_observations,connector_source_mappings,orders_entities,inventory_entities,exceptions,playbook_definitions CASCADE',
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
        region: 'EU',
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
              adapter: 'bedrock-eu',
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
        { bedrockEu: adapter },
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
      items: expected.items.map((item) => ({
        ...item,
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
          jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set($7::jsonb,
            '{entityId}',to_jsonb(s.id::text)),'{connectionId}',to_jsonb(s.connection_id::text)),
            '{observationId}',to_jsonb(CASE WHEN s.connection_id=$2 THEN $4 ELSE $8 END::text)),
            '{sourceUpdatedAt}',to_jsonb(to_char((timestamptz '2024-01-01' + s.n * interval '17 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
            '{data,displayNumber}',to_jsonb('#' || (100000 + s.n))),
            '{data,placedAt}',to_jsonb(to_char((timestamptz '2024-01-01' + s.n * interval '13 minutes' + s.offset_minutes * interval '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
            '{data,status}',to_jsonb(CASE WHEN s.n % 4 = 0 THEN 'completed' ELSE 'open' END))
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
    position.key = middle.placed_key;
    position.id = middle.entity_id;
    const deep = await timed('deep cursor', (workspace) =>
      workspace.list(context(), {
        ...query,
        cursor: Buffer.from(JSON.stringify(position)).toString('base64url'),
      }),
    );
    expect(deep.items).toHaveLength(100);
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
});
