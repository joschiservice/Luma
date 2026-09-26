import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { createCommerceServices } from '@luma/application-runtime';
import type { CommerceObservation, SourceIdentity } from '@luma/connections';
import {
  createConnectionCoverage,
  createProductIdentityReader,
  createReadChecks,
} from '@luma/connections/composition';
import { makeTenantContext } from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

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

  function context(tenantId = tenant) {
    return makeTenantContext(
      { userId: 'operator', sessionId: 'session' },
      {
        id: tenantId,
        name: 'Fixture',
        slug: 'fixture',
        status: 'active',
        dataRegion: 'EU',
      },
      {
        id: 'membership',
        organizationId: tenantId,
        userId: 'operator',
        role: 'owner',
      },
      randomUUID(),
    );
  }

  function stock(
    options: {
      connectionId?: string;
      amount?: string | null;
      time?: string | null;
      external?: string;
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
        observedAt: '2026-09-19T00:00:00Z',
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

  async function mapStock(input: ReturnType<typeof stock>, key: string) {
    const o = input.observation;
    await services.ingestion.ingest(context(), key, input);
    await services.ingestion.bind(
      context(),
      { ...o.source, ...o.data.sku },
      'shared-sku',
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
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(
      `GRANT luma_connectors,luma_orders,luma_inventory,luma_case_reader TO "${name}"`,
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
    expect(positions.map((p) => p.snapshot.data.available).sort()).toEqual([
      '3',
      '5',
    ]);
    expect(
      await services.inventory.current(context(otherTenant), left.entityId),
    ).toEqual([]);
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
      )?.snapshot.data.available,
    ).toBe('-2.500001');
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
    expect(history.some((s) => s.data.available === null)).toBe(true);
    expect(history.some((s) => s.data.available === '0')).toBe(true);
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
      expect(current.data.status).toBe(status);
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
});
