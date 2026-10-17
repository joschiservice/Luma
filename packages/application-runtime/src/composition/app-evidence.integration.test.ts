import { randomUUID } from 'node:crypto';

import {
  createShippingMethodEvidenceStore,
  readShippingMethodEvidence,
} from '@luma/app-jtl';
import { createCorrectionStore, readShopifyEvidence } from '@luma/app-shopify';
import type { CitedRead, EffectIntent } from '@luma/connections';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase } from '../test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const context = (tenantId: string) =>
  makeTenantContext(
    { userId: '00000000-0000-4000-8000-0000000000ad', sessionId: 'session' },
    {
      id: tenantId,
      name: 'Store',
      slug: 'store',
      dataRegion: 'AU',
      status: 'active',
    },
    builtInMembership(
      {
        id: 'membership',
        organizationId: tenantId,
        userId: '00000000-0000-4000-8000-0000000000ad',
      },
      'owner',
    ),
    randomUUID(),
  );

describe.skipIf(!databaseUrl)('app-stored evidence on PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let runtime: Pool;
  let tenants: ReturnType<typeof createTenantDatabase>;
  const role = `app_evidence_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    database = await createMigratedDatabase(databaseUrl!);
    const password = randomUUID();
    await database.owner.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    // App-owned evidence belongs to the connector runtime group.
    await database.owner.query(`GRANT luma_connectors TO "${role}"`);
    const url = new URL(
      (database.owner.options as { connectionString: string }).connectionString,
    );
    url.username = role;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString(), max: 2 });
    tenants = createTenantDatabase(runtime);
  });

  afterAll(async () => {
    await runtime?.end();
    await database?.owner.query(`DROP OWNED BY "${role}"`).catch(() => {});
    await database?.drop();
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  });

  async function connection(tenantId: string, provider: string) {
    const id = randomUUID();
    await database.owner.query(
      'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
      [
        tenantId,
        id,
        {
          id,
          tenantId,
          version: 1,
          status: 'active',
          provider,
          target: { kind: provider },
          label: provider,
          permissions: [],
          granted: [],
        },
        'encrypted-fixture',
      ],
    );

    return id;
  }

  function intent(tenantId: string, connectionId: string): EffectIntent {
    return {
      tenantId,
      connectionId,
      capability: 'orders.shipping-method.write',
      capabilityVersion: '0',
      target: { kind: 'order', id: randomUUID() },
      parameters: {},
      preconditions: {
        evidenceRefs: [randomUUID()],
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      },
      expectedPostcondition: { shippingMethodId: '8' },
    };
  }

  function read(tenantId: string, connectionId: string): CitedRead {
    return {
      id: randomUUID(),
      source: {
        tenantId,
        connectionId,
        provider: 'jtl',
        resource: 'order',
        externalId: '10',
        scopeKey: '',
      },
      kind: 'snapshot',
      observedAt: '2026-10-17T10:00:00.000Z',
      sourceUpdatedAt: null,
      sourceRevision: null,
      adapterVersion: 'jtl/8',
      schemaVersion: 1,
      data: {
        shippingMethod: { externalId: '8', scopeKey: '' },
        isCancelled: false,
        orderStatus: 'open',
      },
      completeness: 'complete',
    };
  }

  it('stores and resolves the shipping-method reads and receipts a correction cites, per tenant', async () => {
    const tenantId = randomUUID(),
      otherTenant = randomUUID();
    const connectionId = await connection(tenantId, 'jtl');
    const otherConnection = await connection(otherTenant, 'jtl');
    const store = createShippingMethodEvidenceStore(tenants);
    const tenant = context(tenantId);
    const action = intent(tenantId, connectionId);

    const verification = read(tenantId, connectionId);
    await store.storeRead(tenant, action, verification);
    const receiptId = await store.storeReceipt(tenant, action, {
      provider: 'jtl',
      connectionId,
      capability: 'orders.shipping-method.write',
      adapterVersion: 'jtl/8',
      dispatchIdentity: '["jtl","jtl/8"]',
      idempotencyKey: `v0:${randomUUID()}`,
      acceptedAt: '2026-10-17T10:00:01.000Z',
      providerRequestId: 'request-1',
      records: [{ resource: 'order', externalId: '10' }],
    });

    const resolved = await tenants.transaction(tenantId, (tx) =>
      readShippingMethodEvidence(tx, tenantId, [verification.id, receiptId]),
    );
    expect(resolved).toEqual(
      expect.arrayContaining([
        {
          kind: 'read',
          id: verification.id,
          provider: 'jtl',
          connectionId,
          record: { resource: 'order', externalId: '10' },
          observedAt: '2026-10-17T10:00:00.000Z',
          sourceUpdatedAt: null,
          sourceRevision: null,
          adapterVersion: 'jtl/8',
          completeness: 'complete',
          data: verification.data,
        },
        {
          kind: 'write_receipt',
          id: receiptId,
          provider: 'jtl',
          connectionId,
          capability: 'orders.shipping-method.write',
          acceptedAt: '2026-10-17T10:00:01.000Z',
          records: [{ resource: 'order', externalId: '10' }],
          providerRequestId: 'request-1',
          adapterVersion: 'jtl/8',
          dispatchIdentity: '["jtl","jtl/8"]',
        },
      ]),
    );
    expect(resolved).toHaveLength(2);

    // Another workspace resolves none of it, even naming the IDs.
    expect(
      await tenants.transaction(otherTenant, (tx) =>
        readShippingMethodEvidence(tx, otherTenant, [
          verification.id,
          receiptId,
        ]),
      ),
    ).toEqual([]);
    // Evidence of another connection is refused and nothing is stored.
    const foreign = read(otherTenant, otherConnection);
    await expect(store.storeRead(tenant, action, foreign)).rejects.toThrow(
      'The read does not belong to this correction.',
    );
    await expect(
      tenants.transaction(tenantId, (tx) =>
        readShippingMethodEvidence(tx, tenantId, [foreign.id]),
      ),
    ).resolves.toEqual([]);
    // A read must say how complete it was.
    await expect(
      tenants.transaction(tenantId, (tx) =>
        tx.query(
          "INSERT INTO jtl_shipping_method_evidence(tenant_id,id,connection_id,kind,observed_at,document) VALUES($1,$2,$3,'read',now(),$4)",
          [
            tenantId,
            foreign.id,
            connectionId,
            {
              ...read(tenantId, connectionId),
              id: foreign.id,
              completeness: undefined,
            },
          ],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
    // The runtime role can neither change nor remove stored evidence.
    await expect(
      tenants.transaction(tenantId, (tx) =>
        tx.query('DELETE FROM jtl_shipping_method_evidence WHERE id=$1', [
          verification.id,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('returns the provenance new Shopify evidence records and leaves older rows not recorded', async () => {
    const tenantId = randomUUID();
    const connectionId = await connection(tenantId, 'shopify');
    const store = createCorrectionStore(tenants);
    const tenant = context(tenantId);
    const [current, accepted, older] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await store.record(tenant, connectionId, {
      id: current,
      kind: 'observation',
      observedAt: '2026-10-17T10:00:00.000Z',
      document: {
        id: current,
        complete: true,
        available: 4,
        adapterVersion: 'shopify-inventory/1',
        completeness: 'complete',
        sourceRevision: 'a'.repeat(64),
        sourceUpdatedAt: '2026-10-17T09:59:00.000Z',
        record: { resource: 'inventory_level', externalId: 'gid://1' },
      },
    });
    await store.record(tenant, connectionId, {
      id: accepted,
      kind: 'acceptance',
      observedAt: '2026-10-17T10:00:01.000Z',
      document: {
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        locationId: 'gid://shopify/Location/1',
        adjustmentId: 'gid://shopify/InventoryAdjustmentGroup/1',
        adapterVersion: 'shopify-inventory/1',
        dispatchIdentity: '["shopify","shopify-inventory/1"]',
        idempotencyKey: 'v0:1',
        records: [
          {
            resource: 'inventory_adjustment_group',
            externalId: 'gid://shopify/InventoryAdjustmentGroup/1',
          },
        ],
      },
    });
    await store.record(tenant, connectionId, {
      id: older,
      kind: 'observation',
      observedAt: '2026-10-17T09:00:00.000Z',
      document: { complete: true, available: 3 },
    });

    const resolved = await tenants.transaction(tenantId, (tx) =>
      readShopifyEvidence(tx, tenantId, [current, accepted, older]),
    );
    const byId = new Map(resolved.map((item) => [item.id, item]));
    expect(byId.get(current)).toMatchObject({
      kind: 'read',
      adapterVersion: 'shopify-inventory/1',
      completeness: 'complete',
      sourceRevision: 'a'.repeat(64),
      sourceUpdatedAt: '2026-10-17T09:59:00.000Z',
      record: { resource: 'inventory_level', externalId: 'gid://1' },
    });
    expect(byId.get(accepted)).toMatchObject({
      kind: 'write_receipt',
      adapterVersion: 'shopify-inventory/1',
      dispatchIdentity: '["shopify","shopify-inventory/1"]',
      records: [
        {
          resource: 'inventory_adjustment_group',
          externalId: 'gid://shopify/InventoryAdjustmentGroup/1',
        },
      ],
    });
    expect(byId.get(older)).toMatchObject({
      kind: 'read',
      adapterVersion: null,
      sourceRevision: null,
      record: null,
    });
  });
});
