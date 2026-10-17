import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';

import {
  buildApp,
  createCommerceServices,
  createSalesRuntime,
} from '@luma/application-runtime';
import { createAuditLog } from '@luma/audit/composition';
import type { CommerceObservation, SourceIdentity } from '@luma/connections';
import {
  commerceSchema,
  createConnectionCoverage,
  createInternalOrderSource,
  createOrderSourceVisibility,
  createProductIdentityReader,
  createReadChecks,
  createSourceAuthority,
} from '@luma/connections/composition';
import { orderAttentionQuery } from '@luma/exceptions/composition';
import type { IdentityService } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createOrderMetricReader } from '@luma/orders/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { createReplenishmentStore } from '@luma/procurement/composition';
import {
  createOperationalMetrics,
  createRecordExplorer,
} from '@luma/read-models/composition';
import { createDetectionSources } from '@luma/resolution/composition';
import {
  createSalesPersistence,
  createSalesSource,
} from '@luma/sales/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

const available = (data: object) =>
  'available' in data ? data.available : undefined;

describe.skipIf(!databaseUrl)('canonical commerce on PostgreSQL', () => {
  const name = `commerce_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  let owner: Pool,
    runtime: Pool,
    services: ReturnType<typeof createCommerceServices>;
  const tenant = randomUUID(),
    otherTenant = randomUUID(),
    connection = randomUUID(),
    secondConnection = randomUUID();

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

  function stock(
    options: {
      connectionId?: string;
      amount?: string | null;
      time?: string | null;
      external?: string;
      observed?: string;
    } = {},
  ): CommerceObservation & { capability: 'inventory.read' } {
    return {
      capability: 'inventory.read',
      observation: {
        id: randomUUID(),
        source: {
          tenantId: tenant,
          connectionId: options.connectionId ?? connection,
          provider: 'shopify',
          resource: 'sku',
          externalId: options.external ?? '001',
          scopeKey: '',
        },
        kind: 'snapshot',
        observedAt: options.observed ?? '2026-09-19T00:00:00Z',
        sourceUpdatedAt:
          options.time === undefined ? '2026-09-18T00:00:00Z' : options.time,
        sourceRevision: 'opaque-A',
        adapterVersion: 'fixture/1',
        schemaVersion: 1,
        data: {
          sku: { externalId: options.external ?? '001', scopeKey: '' },
          location: { externalId: 'warehouse', scopeKey: '' },
          unit: 'each',
          onHand: null,
          reserved: null,
          available: options.amount === undefined ? '3' : options.amount,
          availabilityBasis: 'provider_reported',
        },
      },
    };
  }

  async function mapStock(
    input: ReturnType<typeof stock>,
    key: string,
    skuKey = 'shared-sku',
  ) {
    const o = input.observation;
    await services.ingestion.ingest(context(), key, input);
    await services.ingestion.bind(
      context(),
      { ...o.source, ...o.data.sku },
      skuKey,
      o.id,
      'operator-confirmed',
    );
    await services.ingestion.bind(
      context(),
      { ...o.source, ...o.data.location, resource: 'location' },
      'shared-location',
      o.id,
      'operator-confirmed',
    );

    return services.ingestion.replay(context(), o.source.connectionId, key);
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
    await admin.query(
      `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(
      `GRANT luma_connectors,luma_orders,luma_inventory,luma_case_reader,luma_sales TO "${name}"`,
    );
    url.username = name;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString() });
    services = createCommerceServices(url.toString());
    for (const [tenantId, id] of [
      [tenant, connection],
      [tenant, secondConnection],
      [otherTenant, connection],
    ]) {
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
            target: { kind: 'shopify' },
            label: 'Fixture',
            permissions: [],
            granted: [],
          },
          'encrypted-fixture',
        ],
      );
    }
  });
  afterAll(async () => {
    await services?.close();
    await runtime?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.end();
  });
  beforeEach(async () => {
    await owner.query(
      'TRUNCATE connector_observations,connector_source_mappings,orders_entities,inventory_entities CASCADE',
    );
  });
  it('owns orders atomically with retry-safe edits, explicit authority and tenant isolation', async () => {
    const input: CommerceObservation & { capability: 'orders.read' } = {
      capability: 'orders.read',
      observation: {
        id: randomUUID(),
        source: {
          tenantId: tenant,
          connectionId: connection,
          provider: 'shopify',
          resource: 'order',
          externalId: 'native-order',
          scopeKey: '',
        },
        kind: 'snapshot',
        observedAt: new Date().toISOString(),
        sourceUpdatedAt: new Date().toISOString(),
        sourceRevision: '1',
        adapterVersion: 'fixture/1',
        schemaVersion: 1,
        data: {
          displayNumber: `NATIVE-${randomUUID()}`,
          status: 'open',
          paymentStatus: 'paid',
          total: { amount: '20', currency: 'EUR' },
          lines: [
            {
              id: { externalId: 'native-line', scopeKey: 'native-order' },
              sku: null,
              quantity: { amount: '2', unit: 'each' },
              currentQuantity: { amount: '2', unit: 'each' },
              cancelledQuantity: { amount: '0', unit: 'each' },
              unitPrice: { amount: '10', currency: 'EUR' },
              taxRate: '0',
            },
          ],
        },
      },
    };
    const imported = await services.ingestion.import(
      context(),
      'native-intake',
      input,
    );
    if (imported.status === 'pending') throw new Error('Fixture must project');
    const orderId = imported.entityId;
    const db = createTenantDatabase(runtime);
    const authority = (scoped: typeof db) =>
      createSourceAuthority(
        scoped,
        (provider) => (provider === 'luma-erp' ? 'erp' : 'storefront'),
        async (c) => c,
        async () => true,
      );
    const sales = createSalesRuntime(
      db,
      {
        refreshContext: async (c) => c,
        resolveWorkflowContext: async () => {
          throw new Error('This Sales fixture has no stock approval reviewer');
        },
      },
      async () => true,
      authority,
    );
    const off = createSalesRuntime(
      db,
      {
        refreshContext: async (c) => c,
        resolveWorkflowContext: async () => {
          throw new Error('This Sales fixture has no stock approval reviewer');
        },
      },
      async () => false,
      authority,
    );
    await expect(
      off.accept(context(), orderId, connection),
    ).rejects.toMatchObject({ statusCode: 404 });
    const member = makeTenantContext(
      { userId: 'reader', sessionId: 'reader' },
      {
        id: tenant,
        name: 'Fixture',
        slug: 'fixture',
        status: 'active',
        dataRegion: 'AU',
      },
      builtInMembership(
        { id: 'reader', organizationId: tenant, userId: 'reader' },
        'member',
      ),
      randomUUID(),
    );
    await expect(
      sales.accept(member, orderId, connection),
    ).rejects.toMatchObject({ statusCode: 403 });
    const [record, retry] = await Promise.all([
      sales.accept(context(), orderId, connection),
      sales.accept(context(), orderId, connection),
    ]);
    expect(retry.id).toBe(record.id);
    expect(await sales.get(context(otherTenant), orderId)).toBeNull();
    expect(await services.orders.current(context(), orderId)).toHaveLength(2);
    expect(await services.orders.history(context(), orderId)).toHaveLength(2);
    expect(
      await createSourceAuthority(
        db,
        () => 'erp',
        async (c) => c,
      ).read(context()),
    ).toMatchObject({
      connections: expect.not.arrayContaining([
        expect.objectContaining({ id: record.connectionId }),
      ]),
    });
    const command = {
      commandId: randomUUID(),
      version: record.version,
      status: 'cancelled' as const,
    };
    await expect(sales.edit(context(), orderId, command)).rejects.toMatchObject(
      { statusCode: 409 },
    );
    for (const group of ['order_lifecycle', 'order_lines'] as const) {
      const current = await authority(db).read(context());
      await authority(db).change(context(), {
        commandId: randomUUID(),
        revision: current.revision,
        group,
        connectionId: record.connectionId,
      });
    }
    const address = {
      name: 'Private name',
      company: '',
      street: 'Private address',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    };
    const addressEdit = {
      commandId: randomUUID(),
      version: 1,
      shippingAddress: address,
    };
    const addressed = await sales.edit(context(), orderId, addressEdit);
    expect(addressed.version).toBe(2);
    expect(await services.orders.history(context(), orderId)).toHaveLength(2);
    expect(await sales.edit(context(), orderId, addressEdit)).toEqual(
      addressed,
    );
    await expect(
      sales.edit(context(), orderId, { ...addressEdit, status: 'cancelled' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(sales.edit(context(), orderId, command)).rejects.toMatchObject(
      { statusCode: 409 },
    );
    const hidden = createOrderSourceVisibility(db, async () => false);
    expect(await hidden(context())).toContain(record.connectionId);
    const unreleased = await createRecordExplorer(db, hidden).get(
      context(),
      'order',
      orderId,
    );
    expect(
      unreleased?.record.sources.map((source) => source.connectionId),
    ).toEqual([connection]);
    expect(unreleased?.snapshots).toHaveLength(1);
    const readSource = createSalesSource(
      db,
      async () => true,
      (observation) => {
        commerceSchema.parse({ capability: 'orders.read', observation });
      },
    );
    const internal = await readSource(context(), record.connectionId);
    const reader = internal?.capabilities['orders.read'];
    if (!reader) throw new Error('Internal read capability missing');
    const page = await reader.run(
      {
        tenant: context(),
        connectionId: record.connectionId,
        provider: 'luma-erp',
      },
      { limit: 10 },
    );
    const validated = reader.parseOutput(page);
    expect(validated.items).toHaveLength(1);
    expect(validated.items[0]?.sourceRevision).toBe('2');
    expect(JSON.stringify(validated)).not.toContain('Private');
    const salesOrderId = validated.items[0]!.source.externalId;
    const invocation = {
      tenant: context(),
      connectionId: record.connectionId,
      provider: 'luma-erp',
    };
    const single = reader.parseOutput(
      await reader.run(
        invocation,
        reader.parseInput({
          limit: 1,
          order: { externalId: salesOrderId, scopeKey: '' },
        }),
      ),
    );
    expect(single).toMatchObject({
      nextCursor: null,
      items: [{ source: { externalId: salesOrderId }, sourceRevision: '2' }],
    });
    expect(
      await reader.run(invocation, {
        limit: 1,
        order: { externalId: randomUUID(), scopeKey: '' },
      }),
    ).toMatchObject({ items: [], nextCursor: null, completeness: 'complete' });
    expect(() =>
      reader.parseInput({
        limit: 1,
        cursor: salesOrderId,
        order: { externalId: salesOrderId, scopeKey: '' },
      }),
    ).toThrow();
    expect(
      await createSalesSource(
        db,
        async () => false,
        () => undefined,
      )(context(), record.connectionId),
    ).toBeNull();
    await expect(
      off.edit(context(), orderId, {
        commandId: randomUUID(),
        version: 2,
        status: 'cancelled',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    if (process.env.LUMA_ORDER_BENCHMARK) {
      const rollback = new Error('Benchmark rollback');
      const samples = { record: [] as number[], publication: [] as number[] };
      for (let iteration = 0; iteration < 40; iteration++) {
        for (const publish of [false, true]) {
          const started = performance.now();
          await expect(
            db.transaction(tenant, async (tx) => {
              await tx.query(
                'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                [`sales:${tenant}`],
              );
              await tx.query(
                'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
                [`commerce-ingestion:${tenant}`],
              );
              const scoped: typeof db = {
                transaction: async (_tenantId, work) => work(tx),
              };
              const commerce = createCommerceServices(scoped);
              const persistence = createSalesPersistence(tx, context(), {
                sources: commerce.sources,
                orders: commerce.orders,
                source: createInternalOrderSource(scoped),
                authority: authority(scoped),
                audit: createAuditLog(scoped),
                reconcileStock: async () => undefined,
              });
              const previous = await persistence.get(orderId);
              if (!previous) throw new Error('Benchmark record missing');
              const next = {
                ...previous,
                version: previous.version + 1,
                updatedAt: new Date().toISOString(),
                total: null,
                lines: previous.lines.map((line) => ({
                  ...line,
                  currentQuantity: '1',
                })),
              };
              const commandId = randomUUID();
              await persistence.requireAuthority(next);
              await persistence.save(next);
              if (publish) await persistence.publish(next);
              await persistence.audit(next, commandId, 'edited');
              await persistence.remember(
                commandId,
                orderId,
                {
                  commandId,
                  version: previous.version,
                  lines: [{ id: next.lines[0]!.id, currentQuantity: '1' }],
                },
                next,
              );
              throw rollback;
            }),
          ).rejects.toBe(rollback);
          if (iteration >= 10)
            samples[publish ? 'publication' : 'record'].push(
              performance.now() - started,
            );
        }
      }
      const percentile = (values: number[], fraction: number) =>
        [...values].sort((a, b) => a - b)[
          Math.floor((values.length - 1) * fraction)
        ]!;
      await writeFile(
        '/tmp/luma176-native-order-benchmark.json',
        JSON.stringify({
          record: {
            medianMs: percentile(samples.record, 0.5),
            p95Ms: percentile(samples.record, 0.95),
          },
          publication: {
            medianMs: percentile(samples.publication, 0.5),
            p95Ms: percentile(samples.publication, 0.95),
          },
          medianOverheadMs:
            percentile(samples.publication, 0.5) -
            percentile(samples.record, 0.5),
        }),
      );
    }
    // Fail after record and snapshot writes: the owner transaction rolls back every effect.
    const failingDb: typeof db = {
      transaction: (tenantId, work, options) =>
        db.transaction(
          tenantId,
          (tx) =>
            work({
              query: async (sql, values) => {
                if (sql.startsWith('INSERT INTO audit_entries'))
                  throw new Error('Injected audit failure');

                return tx.query(sql, values);
              },
            }),
          options,
        ),
    };
    const failing = createSalesRuntime(
      failingDb,
      {
        refreshContext: async (c) => c,
        resolveWorkflowContext: async () => {
          throw new Error('This Sales fixture has no stock approval reviewer');
        },
      },
      async () => true,
      authority,
    );
    const cancel = {
      commandId: randomUUID(),
      version: 2,
      status: 'cancelled' as const,
    };
    await expect(failing.edit(context(), orderId, cancel)).rejects.toThrow(
      'Injected audit failure',
    );
    expect((await sales.get(context(), orderId))?.version).toBe(2);
    expect(await services.orders.history(context(), orderId)).toHaveLength(2);
    const cancelled = await sales.edit(context(), orderId, cancel);
    expect(cancelled.version).toBe(3);
    const compared = await owner.query<{
      comparison_raw: string;
      comparison_differences: { values: { connectionId: string }[] }[];
    }>(
      'SELECT comparison_raw,comparison_differences FROM orders_list WHERE tenant_id=$1 AND entity_id=$2 AND selected',
      [tenant, orderId],
    );
    expect(compared.rows[0]?.comparison_raw).toBe('different');
    expect(
      compared.rows[0]?.comparison_differences.some((difference) =>
        difference.values.some(
          (value) => value.connectionId === record.connectionId,
        ),
      ),
    ).toBe(true);
    expect(await services.orders.history(context(), orderId)).toHaveLength(3);
    expect(
      (await services.orders.current(context(), orderId)).find(
        (p) => p.snapshot.connectionId === record.connectionId,
      )?.snapshot.data,
    ).toMatchObject({
      status: 'cancelled',
      lines: [{ currentQuantity: '0', cancelledQuantity: '2' }],
    });
    await expect(
      sales.edit(context(), orderId, {
        commandId: randomUUID(),
        version: 3,
        status: 'open',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const raw = await runtime.connect();
    try {
      await raw.query('BEGIN');
      expect((await raw.query('SELECT * FROM sales_orders')).rows).toHaveLength(
        0,
      );
      await raw.query("SELECT set_config('app.tenant_id',$1,true)", [
        otherTenant,
      ]);
      expect((await raw.query('SELECT * FROM sales_orders')).rows).toHaveLength(
        0,
      );
      await raw.query('SET LOCAL ROLE luma_orders');
      await expect(
        raw.query('SELECT * FROM sales_orders'),
      ).rejects.toMatchObject({ code: '42501' });
      await raw.query('ROLLBACK');
    } finally {
      raw.release();
    }
    const evidence = await owner.query(
      'SELECT document::text FROM connector_observations WHERE tenant_id=$1 AND connection_id=$2',
      [tenant, record.connectionId],
    );
    expect(evidence.rows.map((row) => row.document).join('')).not.toContain(
      'Private',
    );
  }, 60_000);

  it('reads only requested replenishment positions and connections under tenant RLS', async () => {
    const first = await mapStock(stock({ amount: '3' }), 'watched-first');
    await mapStock(
      stock({ connectionId: secondConnection, amount: '5' }),
      'watched-second',
    );
    await mapStock(
      stock({ external: 'unwatched', amount: '99' }),
      'unwatched',
      'OTHER-SKU',
    );
    if (first.status === 'pending')
      throw new Error('Stock projection did not complete');
    const store = createReplenishmentStore(createTenantDatabase(runtime));
    expect(await store.stocksFor(context(), [])).toEqual([]);
    expect(
      await store.stocksFor(context(), [
        { positionId: first.entityId, connectionId: connection },
      ]),
    ).toMatchObject([
      { positionId: first.entityId, connectionId: connection, available: 3 },
    ]);
    expect(
      await store.stocksFor(context(), [
        { positionId: first.entityId, connectionId: secondConnection },
      ]),
    ).toMatchObject([
      {
        positionId: first.entityId,
        connectionId: secondConnection,
        available: 5,
      },
    ]);
    expect(
      await store.stocksFor(context(), [{ positionId: first.entityId }]),
    ).toHaveLength(2);
    expect(
      await store.stocksFor(context(), [
        { positionId: first.entityId, connectionId: randomUUID() },
      ]),
    ).toEqual([]);
    expect(
      await store.stocksFor(context(otherTenant), [
        { positionId: first.entityId },
      ]),
    ).toEqual([]);
  });

  // Projecting 55 positions takes about 220 sequential transactions. Under a full parallel
  // test run this can pass 5 seconds, and a timed-out test keeps writing into the next one.
  it('bounds stock choices, pages without duplicates and searches literal SKU text', async () => {
    const ids = [];
    for (let i = 0; i < 55; i++) {
      const key = `CHOICE_%_${String(i).padStart(3, '0')}`;
      const result = await mapStock(stock({ external: key }), key, key);
      if (result.status === 'pending')
        throw new Error('Stock projection did not complete');
      ids.push(result.entityId);
    }
    const store = createReplenishmentStore(createTenantDatabase(runtime));
    const first = await store.browseStocks(context(), {});
    expect(first.positions).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await store.browseStocks(context(), {
      cursor: first.nextCursor!,
    });
    expect(second.positions).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.positions, ...second.positions].map((p) => p.positionId),
      ),
    ).toEqual(new Set(ids));
    const chosen = second.positions[0]!;
    expect(
      await store.browseStocks(context(), {
        positionId: chosen.positionId,
        connectionId: connection,
      }),
    ).toMatchObject({
      positions: [{ positionId: chosen.positionId, sku: chosen.sku }],
      nextCursor: null,
    });
    expect(
      (await store.browseStocks(context(), { q: '_%_054' })).positions,
    ).toHaveLength(1);
    expect(
      (await store.browseStocks(context(), { q: '_%_missing' })).positions,
    ).toEqual([]);
    expect(
      (await store.browseStocks(context(otherTenant), {})).positions,
    ).toEqual([]);
    await owner.query(
      "UPDATE inventory_snapshots SET document=jsonb_set(document,'{deleted}','true') WHERE tenant_id=$1 AND entity_id=$2",
      [tenant, chosen.positionId],
    );
    expect(
      (await store.browseStocks(context(), { positionId: chosen.positionId }))
        .positions,
    ).toEqual([]);
    expect(await store.stocksFor(context(), [chosen])).toMatchObject([
      { deleted: true },
    ]);
    await expect(
      store.browseStocks(context(), { cursor: 'bad' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  }, 30000);
  it('searches mapped records within one tenant and keeps differing source facts separate', async () => {
    const first = await mapStock(stock({ amount: '3' }), 'explorer-left');
    const second = await mapStock(
      stock({ connectionId: secondConnection, amount: '5' }),
      'explorer-right',
    );
    if (first.status === 'pending' || second.status === 'pending')
      throw new Error('Stock projection did not complete');
    expect(first.entityId).toBe(second.entityId);
    const explorer = createRecordExplorer(createTenantDatabase(runtime));
    const list = await explorer.list(context(), { q: '' });
    expect(list.coverage).toEqual({
      customer: 'unavailable',
      return: 'unavailable',
    });
    const position = list.items.find((item) => item.kind === 'position');
    expect(position).toMatchObject({
      id: first.entityId,
      coverage: 'projected',
    });
    expect(position?.sources.map((source) => source.connectionId)).toEqual(
      expect.arrayContaining([connection, secondConnection]),
    );
    const scoped = await explorer.list(context(), {
      q: '',
      connectionId: secondConnection,
    });
    expect(
      scoped.items.find((item) => item.kind === 'position')?.sources,
    ).toMatchObject([{ connectionId: secondConnection }]);
    const detail = await explorer.get(context(), 'position', first.entityId);
    expect(
      detail?.snapshots.map((snapshot) => snapshot.data.available),
    ).toEqual(expect.arrayContaining(['3', '5']));
    expect(detail?.links.some((link) => link.kind === 'sku')).toBe(true);
    expect(await explorer.list(context(otherTenant), { q: '' })).toMatchObject({
      items: [],
    });
    expect(
      await explorer.get(context(otherTenant), 'position', first.entityId),
    ).toBeNull();
  });
  it('pages through every matching record with a cursor bound to the search', async () => {
    const ids = Array.from({ length: 60 }, () => randomUUID());
    for (const id of ids) {
      const fingerprint = createHash('sha256').update(id).digest('hex');
      await owner.query(
        'INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,$4,$5)',
        [
          id,
          otherTenant,
          fingerprint,
          'detected',
          {
            id,
            tenantId: otherTenant,
            fingerprint,
            state: 'detected',
            occurrenceCount: 1,
            exceptionClass: 'inventory_mismatch',
            severity: 'medium',
            subject: { subjectKind: 'sku', subjectId: 'paging-sku', scope: [] },
          },
        ],
      );
    }
    try {
      const explorer = createRecordExplorer(createTenantDatabase(runtime));
      const first = await explorer.list(context(otherTenant), { q: '' });
      expect(first.items).toHaveLength(50);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await explorer.list(context(otherTenant), {
        q: '',
        cursor: first.nextCursor!,
      });
      expect(second.items).toHaveLength(10);
      expect(second.nextCursor).toBeNull();
      expect(
        new Set([...first.items, ...second.items].map((item) => item.id)),
      ).toEqual(new Set(ids));
      // A cursor only continues the search that produced it.
      await expect(
        explorer.list(context(otherTenant), {
          q: 'paging',
          cursor: first.nextCursor!,
        }),
      ).rejects.toMatchObject({ statusCode: 400, expose: true });
      await expect(
        explorer.list(context(), { q: '', cursor: first.nextCursor! }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(
        (await explorer.list(context(otherTenant), { q: '', kind: 'order' }))
          .items,
      ).toEqual([]);
    } finally {
      await owner.query('DELETE FROM exceptions WHERE tenant_id=$1', [
        otherTenant,
      ]);
    }
  });
  it('reads product labels by mapped SKU with tenant isolation and latest product revisions', async () => {
    const db = createTenantDatabase(runtime);
    const read = createProductIdentityReader({
      transaction: (tenantId, operation) =>
        db.transaction(tenantId, async (tx) => {
          await tx.query('SET LOCAL ROLE luma_case_reader');

          return operation(tx);
        }),
    });
    const record = createReadChecks(db);
    const inventory = stock();
    await mapStock(inventory, 'product-stock');
    const skuId = (await services.sources.resolve(context(), {
      ...inventory.observation.source,
      ...inventory.observation.data.sku,
    }))!;
    await owner.query(
      `UPDATE connector_installations SET document=document || '{"permissions":["products.read"],"granted":["products.read"]}'::jsonb WHERE tenant_id=$1`,
      [tenant],
    );
    const product = {
      ...inventory.observation,
      source: {
        ...inventory.observation.source,
        resource: 'product' as const,
        externalId: 'product-1',
      },
      data: {
        title: 'Blue shirt',
        status: 'active' as const,
        skus: [
          {
            id: inventory.observation.data.sku,
            code: 'SHIRT-BLUE',
            unit: 'each',
          },
          {
            id: { externalId: 'unmapped', scopeKey: '' },
            code: 'WRONG',
            unit: 'each',
          },
        ],
      },
    };
    const save = (item: typeof product) =>
      record(context(), connection, 'products.read', {
        ok: true,
        value: { items: [item], nextCursor: null, completeness: 'complete' },
      });
    try {
      expect(await read(tenant, skuId)).toEqual([]);
      await save(product);
      expect(await read(tenant, skuId)).toEqual([
        { source: 'shopify', title: 'Blue shirt', sku: 'SHIRT-BLUE' },
      ]);
      expect(await read(otherTenant, skuId)).toEqual([]);
      await save({
        ...product,
        observedAt: '2030-01-02T00:00:00Z',
        data: {
          ...product.data,
          title: 'Renamed shirt',
          skus: [{ ...product.data.skus[0]!, code: 'NEW-SKU' }],
        },
      });
      await save(product); // A late older observation must not replace a newer label.
      expect(await read(tenant, skuId)).toEqual([
        { source: 'shopify', title: 'Renamed shirt', sku: 'NEW-SKU' },
      ]);
      await save({
        ...product,
        observedAt: '2030-01-03T00:00:00Z',
        data: { ...product.data, skus: [] },
      });
      expect(await read(tenant, skuId)).toEqual([]);
      await save({ ...product, observedAt: '2030-01-04T00:00:00Z' });
      expect(await read(tenant, skuId)).toEqual([
        { source: 'shopify', title: 'Blue shirt', sku: 'SHIRT-BLUE' },
      ]);
      await save({
        ...product,
        kind: 'tombstone',
        observedAt: '2030-01-05T00:00:00Z',
      });
      expect(await read(tenant, skuId)).toEqual([]);
    } finally {
      await owner.query(
        'DELETE FROM connector_read_checks WHERE tenant_id=$1',
        [tenant],
      );
      await owner.query(
        `UPDATE connector_installations SET document=document || '{"permissions":[],"granted":[]}'::jsonb WHERE tenant_id=$1`,
        [tenant],
      );
    }
  });
  it('combines observation and successful-check times at the historical coverage boundary', async () => {
    const coverage = createConnectionCoverage(createTenantDatabase(runtime));
    const asOf = '2026-10-10T12:00:00.000Z';
    await owner.query(
      `UPDATE connector_installations SET document=document || $3::jsonb WHERE tenant_id=$1 AND id=$2`,
      [
        tenant,
        connection,
        {
          permissions: ['orders.read', 'inventory.read'],
          granted: ['orders.read', 'inventory.read'],
        },
      ],
    );
    try {
      for (const [capability, observedAt] of [
        ['inventory.read', '2026-10-09T12:00:00Z'],
        ['orders.read', '2026-10-09T10:00:00Z'],
        ['inventory.read', '2026-10-10T12:01:00Z'],
      ]) {
        const id = randomUUID();
        await owner.query(
          `INSERT INTO connector_observations(id,tenant_id,connection_id,ingest_key,document) VALUES($1,$2,$3,$4,$5)`,
          [
            id,
            tenant,
            connection,
            id,
            {
              capability,
              observation: {
                source: { tenantId: tenant, connectionId: connection },
                observedAt,
              },
            },
          ],
        );
      }
      for (const [capability, observedAt, succeeded] of [
        ['inventory.read', '2026-10-09T10:00:00Z', true],
        ['inventory.read', '2026-10-10T11:00:00Z', false],
        ['orders.read', '2026-10-10T21:00:00+09:00', true],
        ['orders.read', '2026-10-10T12:01:00Z', false],
      ])
        await owner.query(
          `INSERT INTO connector_read_checks(tenant_id,connection_id,capability,observed_at,succeeded,document) VALUES($1,$2,$3,$4,$5,'{}')`,
          [tenant, connection, capability, observedAt, succeeded],
        );
      const read = async (at: string) =>
        (await coverage(context(), at)).find((item) => item.id === connection);
      expect(await read(asOf)).toMatchObject({
        freshness: 'fresh',
        status: 'degraded',
        lastObservedAt: asOf,
        nextRefreshAt: '2026-10-10T12:00:00.001Z',
      });
      expect(await read('2026-10-10T11:59:59.999Z')).toMatchObject({
        freshness: 'stale',
        lastObservedAt: '2026-10-09T12:00:00.000Z',
      });
      expect(await read('2026-10-10T12:00:00.001Z')).toMatchObject({
        freshness: 'stale',
        lastObservedAt: asOf,
      });
      expect(await read('2026-10-08T12:00:00.000Z')).toMatchObject({
        freshness: 'unobserved',
        status: 'active',
        lastObservedAt: null,
      });
      expect(await coverage(context(otherTenant), asOf)).toMatchObject([
        { freshness: 'unobserved', status: 'active', lastObservedAt: null },
      ]);
    } finally {
      await owner.query(
        'DELETE FROM connector_read_checks WHERE tenant_id=$1',
        [tenant],
      );
      await owner.query(
        `UPDATE connector_installations SET document=document || '{"permissions":[],"granted":[]}'::jsonb WHERE tenant_id=$1`,
        [tenant],
      );
    }
  });
  it('persists empty read coverage, failures and recovery with tenant isolation', async () => {
    const db = createTenantDatabase(runtime);
    const record = createReadChecks(db);
    const coverage = createConnectionCoverage(db);
    const readCoverage = async () =>
      (
        await coverage(context(), new Date(Date.now() + 1000).toISOString())
      ).find((item) => item.id === connection);
    const success = {
      ok: true as const,
      value: { items: [], nextCursor: null, completeness: 'complete' as const },
    };
    const failed = {
      ok: false as const,
      error: {
        code: 'unavailable' as const,
        effect: 'none' as const,
        retry: 'after_delay' as const,
      },
    };
    await owner.query(
      `UPDATE connector_installations SET document=document || $3::jsonb WHERE tenant_id=$1 AND id=$2`,
      [
        tenant,
        connection,
        {
          label: 'Simulated',
          permissions: ['orders.read', 'fulfillment.read'],
          granted: ['orders.read', 'fulfillment.read'],
        },
      ],
    );
    try {
      expect(await readCoverage()).toMatchObject({
        freshness: 'unobserved',
        status: 'active',
      });
      await record(context(), connection, 'orders.read', success);
      expect(await readCoverage()).toMatchObject({ freshness: 'unobserved' });
      await record(context(), connection, 'fulfillment.read', success);
      expect(await readCoverage()).toMatchObject({
        freshness: 'fresh',
        status: 'active',
      });
      await record(context(), connection, 'orders.read', failed);
      expect(await readCoverage()).toMatchObject({ status: 'degraded' });
      await record(context(), connection, 'orders.read', success);
      expect(await readCoverage()).toMatchObject({
        freshness: 'fresh',
        status: 'active',
      });
      await expect(
        record(context(), connection, 'products.read', success),
      ).rejects.toThrow('Connection capability unavailable');
      expect(
        await coverage(context(otherTenant), new Date().toISOString()),
      ).toMatchObject([{ freshness: 'unobserved' }]);
      expect(
        (await runtime.query('SELECT * FROM connector_read_checks')).rows,
      ).toHaveLength(0);
      await expect(
        record(context(otherTenant), connection, 'orders.read', success),
      ).rejects.toThrow('Connection capability unavailable');
      const stored = await owner.query(
        'SELECT document FROM connector_read_checks WHERE tenant_id=$1',
        [tenant],
      );
      expect(stored.rows).toHaveLength(4);
    } finally {
      await owner.query(
        'DELETE FROM connector_read_checks WHERE tenant_id=$1',
        [tenant],
      );
      await owner.query(
        `UPDATE connector_installations SET document=document || '{"permissions":[],"granted":[],"label":"Fixture"}'::jsonb WHERE tenant_id=$1 AND id=$2`,
        [tenant, connection],
      );
    }
  });
  it.each(['orders', 'inventory'] as const)(
    '%s rejects missing, cross-connection and cross-tenant observation references atomically',
    async (module) => {
      const input: CommerceObservation =
        module === 'orders'
          ? {
              capability: 'orders.read',
              observation: {
                ...stock().observation,
                source: { ...stock().observation.source, resource: 'order' },
                data: {
                  displayNumber: null,
                  status: 'open',
                  paymentStatus: 'unknown',
                  lines: [],
                },
              },
            }
          : stock();
      await services.sources.record(context(), 'valid-provenance', input);
      const otherConnectionInput = structuredClone(input);
      otherConnectionInput.observation.id = randomUUID();
      otherConnectionInput.observation.source.connectionId = secondConnection;
      await services.sources.record(
        context(),
        'other-connection',
        otherConnectionInput,
      );
      const otherTenantInput = structuredClone(input);
      otherTenantInput.observation.id = randomUUID();
      otherTenantInput.observation.source.tenantId = otherTenant;
      await services.sources.record(
        context(otherTenant),
        'other-tenant',
        otherTenantInput,
      );

      const entityId =
        module === 'orders'
          ? await services.orders.identify(
              context(),
              'order',
              'provenance-order',
            )
          : await services.inventory.identify(
              context(),
              'position',
              'provenance-position',
            );
      const skuId = await services.inventory.identify(
        context(),
        'sku',
        'provenance-sku',
      );
      const locationId = await services.inventory.identify(
        context(),
        'location',
        'provenance-location',
      );
      const base = {
        schemaVersion: 1 as const,
        entityId,
        connectionId: connection,
        normalizerVersion: 'commerce/1',
        mappingVersion: 'a'.repeat(64),
        sourceRevision: null,
        sourceUpdatedAt: input.observation.sourceUpdatedAt,
        observedAt: input.observation.observedAt,
        deleted: false,
      };
      const project = (observationId: string) =>
        module === 'orders'
          ? services.orders.project(context(), {
              ...base,
              observationId,
              kind: 'order',
              data: {
                type: 'order',
                displayNumber: null,
                status: 'open',
                paymentStatus: 'unknown',
                lines: [],
              },
            })
          : services.inventory.project(context(), {
              ...base,
              observationId,
              kind: 'position',
              data: {
                type: 'position',
                skuId,
                locationId,
                unit: 'each',
                onHand: null,
                reserved: null,
                available: '3',
                availabilityBasis: 'provider_reported',
              },
            });
      expect(await project(input.observation.id)).toBe('applied');
      const service = services[module];
      const initial = await service.current(context(), entityId);
      for (const observationId of [
        randomUUID(),
        otherConnectionInput.observation.id,
        otherTenantInput.observation.id,
      ]) {
        await expect(project(observationId)).rejects.toMatchObject({
          code: '23503',
          constraint: `${module}_snapshot_observation_fk`,
        });
        expect(await service.current(context(), entityId)).toEqual(initial);
        expect(await service.history(context(), entityId)).toHaveLength(1);
        expect(
          (
            await owner.query(
              `SELECT id FROM ${module}_projection_events WHERE tenant_id=$1`,
              [tenant],
            )
          ).rowCount,
        ).toBe(1);
      }
    },
  );
  it('retains unmapped observations, then compares equivalent stock without merging sources', async () => {
    const input = stock();
    const pending = await services.ingestion.ingest(
      context(),
      'pending',
      input,
    );
    expect(pending.status).toBe('pending');
    expect(
      await services.sources.get(context(), connection, 'pending'),
    ).toEqual(input);
    const left = await mapStock(input, 'pending');
    const right = await mapStock(
      stock({ connectionId: secondConnection, amount: '5' }),
      'right',
    );
    expect(left.status).toBe('applied');
    expect(right.status).toBe('applied');
    if (left.status === 'pending' || right.status === 'pending')
      throw new Error('Expected projection');
    expect(right.entityId).toBe(left.entityId);
    const positions = await services.inventory.current(
      context(),
      left.entityId,
    );
    expect(positions.map((p) => available(p.snapshot.data)).sort()).toEqual([
      '3',
      '5',
    ]);
    expect(
      await services.inventory.current(context(otherTenant), left.entityId),
    ).toEqual([]);
  });
  it('retains distinct Shopify states and replays older commitments without inventing reservations', async () => {
    const legacyInput = stock({ external: 'legacy-states' });
    legacyInput.observation.data.reserved = '5';
    const result = await mapStock(
      legacyInput,
      'legacy-states',
      'legacy-states',
    );
    if (result.status === 'pending') throw new Error('Expected projection');
    const initial = (
      await services.inventory.current(context(), result.entityId)
    )[0]!.snapshot;
    if (initial.data.type !== 'position') throw new Error('Expected position');
    expect(initial).toMatchObject({
      schemaVersion: 4,
      normalizerVersion: 'commerce/4',
      data: { committed: '5', reserved: null, incoming: null },
    });
    const legacy = {
      ...initial,
      schemaVersion: 1 as const,
      normalizerVersion: 'commerce/1',
      data: {
        type: 'position' as const,
        skuId: initial.data.skuId,
        locationId: initial.data.locationId,
        unit: initial.data.unit,
        onHand: null,
        reserved: '5',
        available: '3',
        availabilityBasis: 'provider_reported' as const,
      },
    };
    await services.inventory.project(context(), legacy);
    await services.ingestion.replay(context(), connection, 'legacy-states');
    expect(
      await services.inventory.history(context(), result.entityId),
    ).toContainEqual(legacy);
    expect(
      (await services.inventory.current(context(), result.entityId))[0]!
        .snapshot,
    ).toEqual(initial);
    const current = stock({
      external: 'legacy-states',
      time: '2026-09-20T00:00:00Z',
      observed: '2026-09-20T01:00:00Z',
    });
    Object.assign(current.observation.data, {
      onHand: '3',
      committed: '5',
      reserved: '1',
      available: '-2',
      incoming: '7',
      damaged: '0',
      qualityControl: null,
      safetyStock: '3',
      locationActive: false,
      itemActive: true,
      tracked: true,
      inventorySemantics: 'shopify/1',
    });
    await services.ingestion.ingest(context(), 'current-states', current);
    expect(
      (await services.inventory.current(context(), result.entityId))[0]!
        .snapshot.data,
    ).toMatchObject({
      committed: '5',
      reserved: '1',
      available: '-2',
      incoming: '7',
      qualityControl: null,
      locationActive: false,
      itemActive: true,
    });
    expect(
      await services.inventory.current(context(otherTenant), result.entityId),
    ).toEqual([]);
  });
  it('finds when two stock sources last agreed inside a window under tenant RLS', async () => {
    const at = (seconds: number) =>
      new Date(
        Date.parse('2026-09-20T00:00:00Z') + seconds * 1000,
      ).toISOString();
    const report = (connectionId: string, amount: string, seconds: number) =>
      stock({
        connectionId,
        amount,
        external: 'agreement',
        observed: at(seconds),
        time: at(seconds),
      });
    const first = await mapStock(
      report(connection, '3', 0),
      'agree-l0',
      'agree-sku',
    );
    const second = await mapStock(
      report(secondConnection, '3', 10),
      'agree-r10',
      'agree-sku',
    );
    if (first.status === 'pending' || second.status === 'pending')
      throw new Error('Expected projection');
    // The left source sells one unit; the right source has not caught up.
    await services.ingestion.ingest(
      context(),
      'agree-l60',
      report(connection, '2', 60),
    );
    const sources = createDetectionSources(createTenantDatabase(runtime));
    const window = (since: number, until = 120) => ({
      positionId: first.entityId,
      connectionIds: [connection, secondConnection] as [string, string],
      since: at(since),
      until: at(until),
      tolerance: '0',
    });

    // The gap was first seen in the left report after the agreement.
    expect(await sources.stockAgreement(context(), window(-1))).toEqual({
      agreedAt: at(10),
      mismatchSince: at(60),
      snapshotIds: [expect.any(String), expect.any(String)],
    });
    // Without a later report, the gap is first seen at the end of the window.
    expect(await sources.stockAgreement(context(), window(-1, 30))).toEqual(
      expect.objectContaining({ agreedAt: at(10), mismatchSince: at(30) }),
    );
    // Agreement needs both reports inside the window; reports after `until` are not history.
    expect(await sources.stockAgreement(context(), window(5))).toBeNull();
    expect(await sources.stockAgreement(context(), window(-1, 5))).toBeNull();
    expect(
      await sources.stockAgreement(context(otherTenant), window(-1)),
    ).toBeNull();
  });

  it('counts which stock authority changes a storefront followed inside a window under tenant RLS', async () => {
    const at = (seconds: number) =>
      new Date(
        Date.parse('2026-09-21T00:00:00Z') + seconds * 1000,
      ).toISOString();
    const report = (
      connectionId: string,
      external: string,
      amount: string,
      seconds: number,
    ) =>
      stock({
        connectionId,
        amount,
        external,
        observed: at(seconds),
        time: at(seconds),
      });
    const readable = {
      appId: 'shopify',
      appInstallationVersion: 1,
      permissions: ['inventory.read'],
      granted: ['inventory.read'],
    };
    await owner.query(
      "INSERT INTO workspace_apps(tenant_id,app_id,status,version) VALUES($1,'shopify','installed',1) ON CONFLICT DO NOTHING",
      [tenant],
    );
    await owner.query(
      'UPDATE connector_installations SET document=document||$3::jsonb WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
      [tenant, [connection, secondConnection], readable],
    );
    try {
      const positions: Record<string, string> = {};
      // Each product starts in agreement; `connection` is the authority.
      for (const [sku, amount] of [
        ['lagging', '3'],
        ['followed', '5'],
        ['unchanged', '7'],
        ['recent', '9'],
        ['corrected', '11'],
      ] as const) {
        const left = await mapStock(
          report(connection, sku, amount, 0),
          `follow-${sku}-l0`,
          `follow-${sku}`,
        );
        await mapStock(
          report(secondConnection, sku, amount, 10),
          `follow-${sku}-r10`,
          `follow-${sku}`,
        );
        if (left.status === 'pending') throw new Error('Expected projection');
        positions[sku] = left.entityId;
      }
      const ingest = (input: ReturnType<typeof report>, key: string) =>
        services.ingestion.ingest(context(), key, input);
      // The authority sells one unit; the storefront never follows.
      await ingest(report(connection, 'lagging', '2', 60), 'follow-lag-l60');
      await ingest(report(connection, 'lagging', '2', 120), 'follow-lag-l120');
      // The storefront follows this change.
      await ingest(report(connection, 'followed', '4', 60), 'follow-f-l60');
      await ingest(
        report(secondConnection, 'followed', '4', 90),
        'follow-f-r90',
      );
      // The storefront differs, but the authority did not change in the window.
      await ingest(
        report(secondConnection, 'unchanged', '6', 60),
        'follow-u-r60',
      );
      // Luma corrected the storefront itself; that is no evidence that the sync works.
      const corrected = report(secondConnection, 'corrected', '10', 90);
      Object.assign(corrected.observation.data, {
        writeAttribution: {
          evidenceId: randomUUID(),
          adjustmentId: 'gid://shopify/InventoryAdjustmentGroup/1',
          referenceDocumentUri: 'luma://inventory-corrections/1',
          available: '10',
          quantityMatches: true,
        },
      });
      await ingest(report(connection, 'corrected', '10', 60), 'follow-c-l60');
      await ingest(corrected, 'follow-c-r90');
      // A change after the window may still be syncing.
      await ingest(report(connection, 'recent', '8', 600), 'follow-r-l600');
      const sources = createDetectionSources(createTenantDatabase(runtime));
      const options = {
        authorityId: connection,
        storefrontIds: [secondConnection],
        since: at(30),
        before: at(300),
        tolerance: '0',
        limit: 5,
      };

      expect(await sources.stockFollowing(context(), options)).toEqual([
        {
          storefrontId: secondConnection,
          followed: 1,
          lagging: 1,
          laggingSince: at(60),
          positions: [
            {
              positionId: positions.lagging,
              skuId: expect.any(String),
              locationId: expect.any(String),
              changedAt: at(60),
            },
          ],
        },
      ]);
      expect(
        await sources.stockFollowing(context(), { ...options, limit: 0 }),
      ).toEqual([expect.objectContaining({ lagging: 1, positions: [] })]);
      expect(
        await sources.stockFollowing(context(otherTenant), options),
      ).toEqual([]);
    } finally {
      await owner.query(
        "UPDATE connector_installations SET document=document-'appId'-'appInstallationVersion'||'{\"permissions\":[],\"granted\":[]}'::jsonb WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
        [tenant, [connection, secondConnection]],
      );
    }
  });

  it('deduplicates concurrent retries and rejects changed content under one ingest key', async () => {
    await mapStock(stock(), 'seed');
    const input = stock({ time: '2026-09-18T01:00:00Z' });
    const results = await Promise.all([
      services.ingestion.ingest(context(), 'concurrent', input),
      services.ingestion.ingest(context(), 'concurrent', input),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'applied',
      'duplicate',
    ]);
    const changed = structuredClone(input);
    changed.observation.data.available = '9';
    await expect(
      services.ingestion.ingest(context(), 'concurrent', changed),
    ).rejects.toThrow('Ingest key conflict');
  });
  it('preserves stale, ambiguous, tombstone, null, zero, and fractional stock evidence', async () => {
    await mapStock(stock(), 'seed');
    const newest = stock({ time: '2026-09-18T02:00:00Z', amount: '-2.500001' });
    const result = await services.ingestion.ingest(context(), 'newest', newest);
    if (result.status === 'pending') throw new Error('Expected projection');
    expect(
      (
        await services.ingestion.ingest(
          context(),
          'stale',
          stock({ time: '2026-09-17T00:00:00Z', amount: '7' }),
        )
      ).status,
    ).toBe('retained');
    expect(
      (
        await services.ingestion.ingest(
          context(),
          'ambiguous',
          stock({ time: null, amount: '8' }),
        )
      ).status,
    ).toBe('retained');
    expect(
      (await services.inventory.current(context(), result.entityId)).find(
        (p) => p.snapshot.connectionId === connection,
      )?.snapshot.data,
    ).toMatchObject({ available: '-2.500001' });
    const tombstone = stock({ time: '2026-09-18T03:00:00Z', amount: null });
    tombstone.observation.kind = 'tombstone';
    expect(
      (await services.ingestion.ingest(context(), 'deleted', tombstone)).status,
    ).toBe('applied');
    expect(
      (
        await services.ingestion.ingest(
          context(),
          'resurrect-stale',
          stock({ time: '2026-09-18T02:30:00Z' }),
        )
      ).status,
    ).toBe('retained');
    expect(
      (await services.inventory.current(context(), result.entityId)).find(
        (p) => p.snapshot.connectionId === connection,
      )?.snapshot.deleted,
    ).toBe(true);
    await services.ingestion.ingest(
      context(),
      'zero',
      stock({ time: '2026-09-18T04:00:00Z', amount: '0' }),
    );
    const history = await services.inventory.history(
      context(),
      result.entityId,
    );
    expect(history.some((s) => available(s.data) === null)).toBe(true);
    expect(history.some((s) => available(s.data) === '0')).toBe(true);
    await expect(
      services.ingestion.ingest(
        context(),
        'precision',
        stock({ amount: '1.0000001' }),
      ),
    ).rejects.toThrow();
    const partial = stock();
    delete (
      partial.observation.data as Partial<typeof partial.observation.data>
    ).available;
    await expect(
      services.ingestion.ingest(context(), 'partial', partial),
    ).rejects.toThrow();
  });
  it('enforces source scope, mapping evidence, immutable mapping and RLS', async () => {
    await mapStock(stock(), 'seed');
    const input = stock();
    await services.ingestion.ingest(context(), 'mapping', input);
    const source = input.observation.source;
    await expect(
      services.sources.bind(
        context(),
        source,
        randomUUID(),
        input.observation.id,
        'manual',
      ),
    ).rejects.toThrow('Canonical mapping target');
    await expect(
      services.ingestion.bind(
        context(),
        source,
        'wrong-sku',
        input.observation.id,
        'manual',
      ),
    ).rejects.toThrow('Source already maps');
    await expect(
      services.ingestion.bind(
        context(),
        { ...source, externalId: 'not-in-evidence' },
        'invented',
        input.observation.id,
        'manual',
      ),
    ).rejects.toThrow('Mapping evidence');
    await expect(
      services.ingestion.bind(
        context(),
        { ...source, connectionId: secondConnection },
        'shared-sku',
        input.observation.id,
        'manual',
      ),
    ).rejects.toThrow('Mapping evidence');
    await expect(
      services.ingestion.ingest(context(otherTenant), 'foreign', input),
    ).rejects.toThrow();
    expect(
      await services.sources.resolve(context(), {
        ...source,
        scopeKey: 'other-parent',
      }),
    ).toBeNull();
    expect(
      await services.sources.resolve(context(), { ...source, externalId: '1' }),
    ).toBeNull();
    expect(
      (await runtime.query('SELECT * FROM connector_observations')).rows,
    ).toEqual([]);
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [
        otherTenant,
      ]);
      expect(
        (
          await client.query(
            'SELECT * FROM inventory_snapshots WHERE tenant_id=$1',
            [tenant],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        client.query('UPDATE connector_observations SET ingest_key=$1', [
          'altered',
        ]),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('reprojects newly mapped SKUs and preserves earlier canonical snapshots', async () => {
    const input: CommerceObservation & { capability: 'orders.read' } = {
      capability: 'orders.read',
      observation: {
        ...stock().observation,
        source: {
          ...stock().observation.source,
          resource: 'order',
          externalId: 'replay-order',
        },
        data: {
          displayNumber: null,
          status: 'unknown',
          paymentStatus: 'unknown',
          lines: [
            {
              id: { externalId: 'replay-line', scopeKey: 'replay-order' },
              sku: { externalId: 'late-sku', scopeKey: '' },
              quantity: { amount: '1', unit: 'each' },
              cancelledQuantity: null,
            },
          ],
        },
      },
    };
    await services.ingestion.ingest(context(), 'late-mapping', input);
    const source = input.observation.source;
    const id = await services.ingestion.bind(
      context(),
      source,
      'replay-order',
      input.observation.id,
      'manual',
    );
    await services.ingestion.bind(
      context(),
      {
        ...source,
        resource: 'order_line',
        ...input.observation.data.lines[0]!.id,
      },
      'replay-line',
      input.observation.id,
      'manual',
    );
    await services.ingestion.replay(context(), connection, 'late-mapping');
    const sku = await services.ingestion.bind(
      context(),
      { ...source, resource: 'sku', externalId: 'late-sku' },
      'late-sku',
      input.observation.id,
      'manual',
    );
    expect(
      (await services.ingestion.replay(context(), connection, 'late-mapping'))
        .status,
    ).toBe('applied');
    const current = (await services.orders.current(context(), id))[0]!;
    expect(current.version).toBe(2);
    expect(
      current.snapshot.data.type === 'order' &&
        current.snapshot.data.lines[0]!.skuId,
    ).toBe(sku);
    expect(await services.orders.history(context(), id)).toHaveLength(2);
    const foreign = structuredClone(current.snapshot);
    foreign.observationId = randomUUID();
    if (foreign.data.type === 'order')
      foreign.data.lines[0]!.skuId = randomUUID();
    await expect(services.orders.project(context(), foreign)).rejects.toThrow(
      'Canonical SKU',
    );
    expect(
      (
        await owner.query(
          'SELECT * FROM orders_projection_events WHERE tenant_id=$1',
          [tenant],
        )
      ).rowCount,
    ).toBe(2);
  });
  it('persists order lines and split source-specific fulfillments with parent and unit checks', async () => {
    const order: CommerceObservation & { capability: 'orders.read' } = {
      capability: 'orders.read',
      observation: {
        ...stock().observation,
        id: randomUUID(),
        source: {
          ...stock().observation.source,
          resource: 'order',
          externalId: 'order-1',
        },
        data: {
          displayNumber: '#100',
          status: 'open',
          paymentStatus: 'paid',
          lines: [
            {
              id: { externalId: 'line-1', scopeKey: 'order-1' },
              sku: null,
              quantity: { amount: '3', unit: 'each' },
              cancelledQuantity: null,
            },
          ],
        },
      },
    };
    await services.ingestion.ingest(context(), 'order', order);
    const source = order.observation.source;
    const orderId = await services.ingestion.bind(
      context(),
      source,
      'canonical-order',
      order.observation.id,
      'manual',
    );
    const lineSource: SourceIdentity = {
      ...source,
      ...order.observation.data.lines[0]!.id,
      resource: 'order_line',
    };
    await services.ingestion.bind(
      context(),
      lineSource,
      'canonical-line',
      order.observation.id,
      'manual',
    );
    expect(
      (await services.ingestion.replay(context(), connection, 'order')).status,
    ).toBe('applied');
    for (const [externalId, status, quantity] of [
      ['shipment-1', 'shipped', '1'],
      ['shipment-2', 'processing', '2'],
      ['work-1', 'completed', '3'],
    ] as const) {
      const shipment: CommerceObservation & { capability: 'fulfillment.read' } =
        {
          capability: 'fulfillment.read',
          observation: {
            ...order.observation,
            id: randomUUID(),
            source: { ...source, resource: 'fulfillment', externalId },
            data: {
              order: { externalId: 'order-1', scopeKey: '' },
              status,
              shipping: {
                stage: status === 'shipped' ? 'carrier' : 'unknown',
                sourceUrl: 'https://tracking.example.test/shipment',
                trackingUpdatedAt:
                  status === 'shipped' ? '2026-09-18T00:00:00Z' : null,
              },
              lines: [
                {
                  orderLine: { externalId: 'line-1', scopeKey: 'order-1' },
                  quantity: { amount: quantity, unit: 'each' },
                },
              ],
              lastProgressAt: null,
              failureCode: null,
            },
          },
        };
      await services.ingestion.ingest(context(), externalId, shipment);
      const id = await services.ingestion.bind(
        context(),
        shipment.observation.source,
        externalId,
        shipment.observation.id,
        'manual',
      );
      expect(
        (await services.ingestion.replay(context(), connection, externalId))
          .status,
      ).toBe('applied');
      const current = (await services.orders.current(context(), id))[0]!
        .snapshot;
      expect(
        current.data.type === 'fulfillment' && current.data.lines[0]!.quantity,
      ).toBe(quantity);
      expect(current.data.type === 'fulfillment' && current.data.status).toBe(
        status,
      );
      expect(current.schemaVersion).toBe(5);
      expect(
        current.data.type === 'fulfillment' && current.data.shipping,
      ).toEqual(shipment.observation.data.shipping);
      const zero = structuredClone(shipment);
      zero.observation.id = randomUUID();
      zero.observation.data.lines[0]!.quantity.amount = '0';
      await expect(
        services.ingestion.ingest(context(), externalId + '-zero', zero),
      ).rejects.toThrow();
      const wrong = structuredClone(shipment);
      wrong.observation.id = randomUUID();
      wrong.observation.data.lines[0]!.quantity.unit = 'box';
      await expect(
        services.ingestion.ingest(context(), externalId + '-wrong', wrong),
      ).rejects.toThrow('same unit');
      const ownerWrong = structuredClone(current);
      ownerWrong.observationId = randomUUID();
      if (ownerWrong.data.type === 'fulfillment')
        ownerWrong.data.lines[0]!.unit = 'box';
      await expect(
        services.orders.project(context(), ownerWrong),
      ).rejects.toThrow('unit mismatch');
    }
    const snapshot = (await services.orders.current(context(), orderId))[0]!
      .snapshot;
    expect(
      snapshot.data.type === 'order' && snapshot.data.lines[0]!.skuId,
    ).toBeNull();
    expect(
      snapshot.data.type === 'order' &&
        snapshot.data.lines[0]!.cancelledQuantity,
    ).toBeNull();
    const second = structuredClone(order);
    second.observation.id = randomUUID();
    second.observation.source.externalId = 'order-2';
    await services.ingestion.ingest(context(), 'other-order', second);
    await services.ingestion.bind(
      context(),
      second.observation.source,
      'other-order',
      second.observation.id,
      'manual',
    );
    await expect(
      services.ingestion.replay(context(), connection, 'other-order'),
    ).rejects.toThrow('another order');
  });
  describe('sources without update times', () => {
    const jtl = randomUUID();

    beforeAll(async () => {
      await owner.query(
        'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
        [
          tenant,
          jtl,
          {
            id: jtl,
            tenantId: tenant,
            version: 1,
            status: 'active',
            target: { kind: 'jtl' },
            label: 'JTL fixture',
            permissions: [],
            granted: [],
          },
          'encrypted-fixture',
        ],
      );
    });

    const source = {
      tenantId: tenant,
      connectionId: jtl,
      provider: 'jtl',
      externalId: '10',
      scopeKey: '',
    };

    function order(
      observedAt: string,
      status: 'open' | 'completed' | 'cancelled',
    ): CommerceObservation & { capability: 'orders.read' } {
      return {
        capability: 'orders.read',
        observation: {
          id: randomUUID(),
          source: { ...source, resource: 'order' },
          kind: 'snapshot',
          observedAt,
          sourceUpdatedAt: null,
          sourceRevision: null,
          adapterVersion: 'jtl/1',
          schemaVersion: 1,
          data: {
            displayNumber: 'SIM-10',
            placedAt: '2026-09-20T09:00:00Z',
            total: { amount: '48', currency: 'EUR' },
            status,
            paymentStatus: 'paid',
            lines: [
              {
                id: { externalId: '101', scopeKey: '10' },
                sku: null,
                quantity: { amount: '2', unit: 'each' },
                cancelledQuantity: null,
                skuCode: 'LUMA-001',
                title: 'Canvas tote',
              },
            ],
          },
        },
      };
    }

    function note(
      observedAt: string,
      status: 'processing' | 'shipped',
    ): CommerceObservation & { capability: 'fulfillment.read' } {
      return {
        capability: 'fulfillment.read',
        observation: {
          id: randomUUID(),
          source: { ...source, externalId: '30', resource: 'fulfillment' },
          kind: 'snapshot',
          observedAt,
          sourceUpdatedAt: null,
          sourceRevision: null,
          adapterVersion: 'jtl/1',
          schemaVersion: 1,
          data: {
            order: { externalId: '10', scopeKey: '' },
            status,
            lines: [
              {
                orderLine: { externalId: '101', scopeKey: '10' },
                quantity: { amount: '2', unit: 'each' },
              },
            ],
            lastProgressAt: '2026-09-20T10:00:00Z',
            progressBasis: 'note_created_or_package_shipped',
            failureCode: null,
          },
        },
      };
    }

    async function mapOrder(input: ReturnType<typeof order>, key: string) {
      expect(
        (await services.ingestion.ingest(context(), key, input)).status,
      ).toBe('pending');
      const id = await services.ingestion.bind(
        context(),
        input.observation.source,
        'jtl-order-10',
        input.observation.id,
        'manual',
      );
      const lineId = await services.ingestion.bind(
        context(),
        {
          ...source,
          externalId: '101',
          scopeKey: '10',
          resource: 'order_line',
        },
        'jtl-line-101',
        input.observation.id,
        'manual',
      );

      return { id, lineId };
    }

    it('makes a later read current and retains an older read that arrives late', async () => {
      const first = order('2026-09-20T10:00:00Z', 'open');
      const { id } = await mapOrder(first, 'jtl-first');
      expect(
        (await services.ingestion.replay(context(), jtl, 'jtl-first')).status,
      ).toBe('applied');

      const completed = order('2026-09-20T10:05:00Z', 'completed');
      expect(
        (await services.ingestion.ingest(context(), 'jtl-second', completed))
          .status,
      ).toBe('applied');
      const late = order('2026-09-20T10:02:00Z', 'cancelled');
      expect(
        (await services.ingestion.ingest(context(), 'jtl-late', late)).status,
      ).toBe('retained');
      const [current] = await services.orders.current(context(), id);
      expect(current).toMatchObject({
        version: 2,
        snapshot: {
          observationId: completed.observation.id,
          schemaVersion: 7,
          normalizerVersion: 'commerce/7',
          sourceUpdatedAt: null,
          data: {
            status: 'completed',
            placedAt: '2026-09-20T09:00:00Z',
            total: { amount: '48', currency: 'EUR' },
            lines: [{ skuCode: 'LUMA-001', title: 'Canvas tote' }],
          },
        },
      });
      expect(await services.orders.history(context(), id)).toHaveLength(3);

      const processing = note('2026-09-20T10:06:00Z', 'processing');
      await services.ingestion.ingest(context(), 'jtl-note', processing);
      const noteId = await services.ingestion.bind(
        context(),
        processing.observation.source,
        'jtl-note-30',
        processing.observation.id,
        'manual',
      );
      expect(
        (await services.ingestion.replay(context(), jtl, 'jtl-note')).status,
      ).toBe('applied');
      expect(
        (
          await services.ingestion.ingest(
            context(),
            'jtl-note-shipped',
            note('2026-09-20T10:10:00Z', 'shipped'),
          )
        ).status,
      ).toBe('applied');
      expect(
        (
          await services.ingestion.ingest(
            context(),
            'jtl-note-late',
            note('2026-09-20T10:08:00Z', 'processing'),
          )
        ).status,
      ).toBe('retained');
      const shipped = (await services.orders.current(context(), noteId))[0]
        ?.snapshot.data;
      expect(shipped?.type === 'fulfillment' && shipped.status).toBe('shipped');
    });

    it('settles equal observation times on the greater observation ID', async () => {
      const first = order('2026-09-20T10:00:00Z', 'open');
      const { id } = await mapOrder(first, 'jtl-tie-seed');
      await services.ingestion.replay(context(), jtl, 'jtl-tie-seed');
      const [low, middle, high] = [
        order('2026-09-20T11:00:00Z', 'completed'),
        order('2026-09-20T11:00:00Z', 'cancelled'),
        order('2026-09-20T11:00:00Z', 'open'),
      ].sort((a, b) => (a.observation.id < b.observation.id ? -1 : 1));
      for (const [key, input, status] of [
        ['jtl-tie-middle', middle!, 'applied'],
        ['jtl-tie-low', low!, 'retained'],
        ['jtl-tie-high', high!, 'applied'],
      ] as const)
        expect(
          (await services.ingestion.ingest(context(), key, input)).status,
        ).toBe(status);
      expect(
        (await services.orders.current(context(), id))[0]?.snapshot
          .observationId,
      ).toBe(high!.observation.id);
    });

    it('keeps stored version 1 order snapshots readable and re-normalizes their observations', async () => {
      const input = order('2026-09-20T10:00:00Z', 'open');
      const { id, lineId } = await mapOrder(input, 'jtl-legacy');
      const lines = [
        {
          id: lineId,
          skuId: null,
          quantity: '2',
          cancelledQuantity: null,
          unit: 'each',
          skuCode: 'LUMA-001',
          title: 'Canvas tote',
        },
      ];
      // The identity the previous normalizer wrote for this observation.
      const legacy = {
        schemaVersion: 1 as const,
        entityId: id,
        kind: 'order' as const,
        connectionId: jtl,
        observationId: input.observation.id,
        normalizerVersion: 'commerce/1',
        mappingVersion: createHash('sha256')
          .update(JSON.stringify([id, lines.map((l) => [l.id, l.skuId])]))
          .digest('hex'),
        sourceRevision: null,
        sourceUpdatedAt: null,
        observedAt: input.observation.observedAt,
        deleted: false,
        data: {
          type: 'order' as const,
          displayNumber: 'SIM-10',
          placedAt: '2026-09-20T09:00:00Z',
          status: 'open',
          paymentStatus: 'paid',
          lines,
        },
      };
      expect(await services.orders.project(context(), legacy)).toBe('applied');
      expect(
        (await services.orders.current(context(), id))[0]?.snapshot,
      ).toEqual(legacy);

      expect(
        await services.orders.project(context(), {
          ...legacy,
          schemaVersion: 2,
          normalizerVersion: 'commerce/2',
        }),
      ).toBe('applied');
      expect(
        (await services.ingestion.replay(context(), jtl, 'jtl-legacy')).status,
      ).toBe('applied');
      const history = await services.orders.history(context(), id);
      expect(
        history.map((s) => [s.schemaVersion, s.normalizerVersion]),
      ).toEqual([
        [1, 'commerce/1'],
        [2, 'commerce/2'],
        [7, 'commerce/7'],
      ]);
      expect(
        (await services.orders.current(context(), id))[0]?.snapshot,
      ).toMatchObject({
        schemaVersion: 7,
        data: { total: { amount: '48', currency: 'EUR' } },
      });
      await expect(
        services.orders.project(context(), {
          ...legacy,
          schemaVersion: 8 as never,
        }),
      ).rejects.toThrow();
    });
  });
  it('reconciles metric cohorts across lifecycle changes, source identity, filters and snapshot conflicts', async () => {
    let clock = new Date('2026-09-20T00:00:00Z');
    const db = createTenantDatabase(runtime);
    const metrics = createOperationalMetrics(
      db,
      {
        orders: (db) => createOrderMetricReader(db, orderAttentionQuery),
        coverage: createConnectionCoverage,
      },
      () => clock,
    );
    const counts = async () =>
      (await metrics(context(), {})).metrics.map((m) => m.observedCount);
    expect(await metrics(context(), {})).toMatchObject({
      coverage: 'unavailable',
      dataThrough: null,
      metrics: [{ total: null }, { total: null }, { total: null }],
    });
    let revision = 0;
    const order: CommerceObservation & { capability: 'orders.read' } = {
      capability: 'orders.read',
      observation: {
        ...stock().observation,
        id: randomUUID(),
        source: {
          ...stock().observation.source,
          resource: 'order',
          externalId: 'metric-order',
        },
        data: {
          displayNumber: '#METRIC',
          status: 'open',
          paymentStatus: 'paid',
          dueAt: '2026-09-20T00:00:00Z',
          lines: [
            {
              id: { externalId: 'metric-line', scopeKey: 'metric-order' },
              sku: null,
              quantity: { amount: '3', unit: 'each' },
              cancelledQuantity: { amount: '0', unit: 'each' },
            },
          ],
        },
      },
    };
    await services.ingestion.ingest(context(), 'metric-order', order);
    const orderId = await services.ingestion.bind(
      context(),
      order.observation.source,
      'metric-order',
      order.observation.id,
      'manual',
    );
    await services.ingestion.bind(
      context(),
      {
        ...order.observation.source,
        ...order.observation.data.lines[0]!.id,
        resource: 'order_line',
      },
      'metric-line',
      order.observation.id,
      'manual',
    );
    await services.ingestion.replay(context(), connection, 'metric-order');
    expect(await counts()).toEqual([1, 0, 0]);
    clock = new Date('2026-09-20T00:00:01Z');
    expect(await counts()).toEqual([1, 1, 0]);
    const first = await metrics(context(), { limit: 1 });
    expect(first.metrics[0]!.items.map((o) => o.id)).toEqual([orderId]);
    expect(first.metrics[0]!.observedCount).toBe(
      first.metrics[0]!.items.length,
    );
    expect(first.metrics[0]!.nextCursor).toBeNull();
    const update = async (change: (v: typeof order) => void, time?: string) => {
      const next = structuredClone(order);
      next.observation.id = randomUUID();
      next.observation.sourceUpdatedAt =
        time ??
        new Date(
          Date.parse('2026-09-18T00:00:00Z') + ++revision * 1000,
        ).toISOString();
      change(next);
      const key = next.observation.id;

      return services.ingestion.ingest(context(), key, next);
    };
    const shipment: CommerceObservation & { capability: 'fulfillment.read' } = {
      capability: 'fulfillment.read',
      observation: {
        ...order.observation,
        id: randomUUID(),
        source: {
          ...order.observation.source,
          resource: 'fulfillment',
          externalId: 'metric-shipment',
        },
        data: {
          order: { externalId: 'metric-order', scopeKey: '' },
          status: 'shipped',
          lastProgressAt: null,
          failureCode: null,
          lines: [
            {
              orderLine: {
                externalId: 'metric-line',
                scopeKey: 'metric-order',
              },
              quantity: { amount: '1', unit: 'each' },
            },
          ],
        },
      },
    };
    await services.ingestion.ingest(context(), 'metric-shipment', shipment);
    await services.ingestion.bind(
      context(),
      shipment.observation.source,
      'metric-shipment',
      shipment.observation.id,
      'manual',
    );
    await services.ingestion.replay(context(), connection, 'metric-shipment');
    expect(await counts()).toEqual([1, 1, 0]);
    shipment.observation.id = randomUUID();
    shipment.observation.sourceUpdatedAt = '2026-09-18T01:00:00Z';
    shipment.observation.data.lines[0]!.quantity.amount = '3';
    await services.ingestion.ingest(context(), 'metric-full', shipment);
    await services.ingestion.replay(context(), connection, 'metric-full');
    expect(await counts()).toEqual([0, 0, 0]);
    await update((v) => {
      v.observation.data.status = 'cancelled';
    });
    expect(await counts()).toEqual([0, 0, 0]);
    await update((v) => {
      v.observation.data.lines[0]!.quantity.amount = '5';
    });
    expect(await counts()).toEqual([1, 1, 0]);
    const retained = await update((v) => {
      v.observation.data.status = 'completed';
    }, '2026-09-17T00:00:00Z');
    expect(retained.status).toBe('retained');
    expect(await counts()).toEqual([1, 1, 0]);
    expect(
      (await services.ingestion.replay(context(), connection, 'metric-full'))
        .status,
    ).toBe('duplicate');
    await update((v) => {
      v.observation.data.dueAt = null;
      v.observation.data.lines[0]!.quantity.amount = '5';
    });
    expect((await metrics(context(), {})).metrics[1]).toMatchObject({
      observedCount: 0,
      unknownCount: 1,
    });
    // A second source maps to the same canonical order and line, never a second count.
    const mirror = structuredClone(order);
    mirror.observation.id = randomUUID();
    mirror.observation.source.connectionId = secondConnection;
    mirror.observation.sourceUpdatedAt = '2026-09-19T00:00:00Z';
    await services.ingestion.ingest(context(), 'metric-mirror', mirror);
    await services.ingestion.bind(
      context(),
      mirror.observation.source,
      'metric-order',
      mirror.observation.id,
      'manual',
    );
    await services.ingestion.bind(
      context(),
      {
        ...mirror.observation.source,
        ...mirror.observation.data.lines[0]!.id,
        resource: 'order_line',
      },
      'metric-line',
      mirror.observation.id,
      'manual',
    );
    await services.ingestion.replay(
      context(),
      secondConnection,
      'metric-mirror',
    );
    expect(await counts()).toEqual([1, 1, 0]);
    expect(
      (await metrics(context(), { scope: { connectionId: connection } }))
        .metrics[1]!.unknownCount,
    ).toBe(1);
    expect(
      (
        await metrics(context(), {
          scope: {
            updatedFrom: '2026-09-19T00:00:00Z',
            updatedBefore: '2026-09-20T00:00:00Z',
          },
        })
      ).metrics[0]!.observedCount,
    ).toBe(1);
    expect(
      (
        await metrics(context(), {
          scope: { updatedBefore: '2026-09-19T00:00:00Z' },
        })
      ).metrics[0]!.observedCount,
    ).toBe(0);
    expect(
      (await metrics(context(otherTenant), {})).metrics.every(
        (m) => m.observedCount === 0,
      ),
    ).toBe(true);
    await expect(
      metrics(context(otherTenant), {
        scope: { connectionId: secondConnection },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const issueId = randomUUID();
    await owner.query(
      `INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,'escalated',$4)`,
      [
        issueId,
        tenant,
        'e'.repeat(64),
        {
          id: issueId,
          tenantId: tenant,
          fingerprint: 'e'.repeat(64),
          state: 'escalated',
          exceptionClass: 'stuck_fulfillment',
          severity: 'high',
          occurrenceCount: 1,
          subject: {
            ruleIdentity: 'fulfillment-progress',
            subjectKind: 'fulfillment',
            subjectId: 'metric-shipment',
            scope: [connection],
          },
          firstDetectedAt: clock.toISOString(),
          lastDetectedAt: clock.toISOString(),
        },
      ],
    );
    const attention = await metrics(context(), {});
    expect(attention.metrics[2]!.observedCount).toBe(1);
    expect(attention.metrics[2]!.items[0]!.issueIds).toEqual([issueId]);
    const app = buildApp(
      {},
      {
        metrics,
        trustedOrigins: ['http://localhost:3000'],
        identity: {
          hasSupportView: () => false,
          resolveTenant: async (_credentials: unknown, id: string) =>
            context(id),
        } as unknown as IdentityService,
      },
    );
    try {
      const url = `/v1/organizations/${tenant}/metrics/query`;
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { origin: 'http://localhost:3000' },
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { origin: 'http://localhost:3000' },
            payload: { sql: 'SELECT *' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { origin: 'http://localhost:3000' },
            payload: { limit: 101 },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { origin: 'http://localhost:3000' },
            payload: { definitionVersion: 2 },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { origin: 'http://localhost:3000' },
            payload: { offset: 1 },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await app.inject(`/v1/organizations/${tenant}/metrics`)).json(),
      ).toHaveLength(3);
    } finally {
      await app.close();
    }
    if (process.env.LUMA_METRIC_BENCHMARK) {
      await owner.query(
        `WITH entities AS (
        INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key)
        SELECT gen_random_uuid(),$1,'order','bench-' || n FROM generate_series(1,10000) n RETURNING id
      ), snapshots AS (
        INSERT INTO orders_snapshots(id,tenant_id,entity_id,kind,connection_id,observation_id,normalizer_version,mapping_version,source_updated_at,observed_at,document)
        SELECT gen_random_uuid(),$1,e.id,'order',$2,$3,'bench/1',$4,'2026-09-19','2026-09-19',
          jsonb_set(jsonb_set($5::jsonb,'{entityId}',to_jsonb(e.id::text)),'{data,displayNumber}',to_jsonb('BENCH-' || e.id::text))
        FROM entities e RETURNING entity_id,id
      ) INSERT INTO orders_projections(tenant_id,entity_id,connection_id,snapshot_id) SELECT $1,entity_id,$2,id FROM snapshots`,
        [
          tenant,
          secondConnection,
          mirror.observation.id,
          (await services.orders.current(context(), orderId))[1]!.snapshot
            .mappingVersion,
          (await services.orders.current(context(), orderId)).find(
            (p) => p.snapshot.connectionId === secondConnection,
          )!.snapshot,
        ],
      );
      await owner.query('ANALYZE orders_projections');
      await owner.query('ANALYZE orders_snapshots');
      const plans: unknown[] = [];
      const measuredDb: typeof db = {
        transaction: (tenantId, operation, options) =>
          db.transaction(
            tenantId,
            async (tx) =>
              operation({
                query: async (sql, values) => {
                  if (sql.startsWith('WITH selected'))
                    plans.push(
                      (
                        await tx.query(
                          'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql,
                          values,
                        )
                      ).rows,
                    );

                  return tx.query(sql, values);
                },
              }),
            options,
          ),
      };
      const measured = createOperationalMetrics(
        measuredDb,
        {
          orders: (db) => createOrderMetricReader(db, orderAttentionQuery),
          coverage: createConnectionCoverage,
        },
        () => clock,
      );
      const durations = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await measured(context(), {});
        durations.push(performance.now() - start);
      }
      const concurrentDurations: number[] = [];
      const loadStart = performance.now();
      for (let batch = 0; batch < 5; batch++) {
        await Promise.all(
          Array.from({ length: 5 }, async () => {
            const start = performance.now();
            await metrics(context(), {});
            concurrentDurations.push(performance.now() - start);
          }),
        );
      }
      const loadElapsed = performance.now() - loadStart;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        '/tmp/luma84-query-plans.json',
        JSON.stringify(
          { rows: 10001, durations, plans, concurrentDurations, loadElapsed },
          null,
          2,
        ),
      );
    }
  }, 60000);
});
