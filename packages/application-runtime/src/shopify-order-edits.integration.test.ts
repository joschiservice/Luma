import { randomUUID } from 'node:crypto';

import { createOrderEditStore } from '@luma/app-shopify';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase } from './test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const context = (tenantId: string) =>
  makeTenantContext(
    { userId: '00000000-0000-4000-8000-0000000000ad', sessionId: 'session' },
    {
      id: tenantId,
      name: 'Store',
      slug: 'store',
      dataRegion: 'EU',
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

describe.skipIf(!databaseUrl)('Shopify order edit store on PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let runtime: Pool;
  let store: ReturnType<typeof createOrderEditStore>;
  const role = `order_edits_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    database = await createMigratedDatabase(databaseUrl!);
    const password = randomUUID();
    await database.owner.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await database.owner.query(`GRANT luma_connectors TO "${role}"`);
    const url = new URL(
      (database.owner.options as { connectionString: string }).connectionString,
    );
    url.username = role;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString(), max: 2 });
    store = createOrderEditStore(createTenantDatabase(runtime));
  });

  afterAll(async () => {
    await runtime?.end();
    await database?.owner.query(`DROP OWNED BY "${role}"`).catch(() => {});
    await database?.drop();
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  });

  async function connection(tenantId: string) {
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
          provider: 'shopify',
          target: { kind: 'shopify', shop: 'edits.myshopify.com' },
          label: 'Edits',
          permissions: ['orders.read'],
          granted: ['orders.read'],
        },
        'encrypted-fixture',
      ],
    );

    return id;
  }

  function run(
    tenantId: string,
    connectionId: string,
    revision = '2026-10-12T09:00:00Z',
  ) {
    const id = randomUUID();

    return {
      id,
      tenantId,
      target: { connectionId, orderId: 'gid://shopify/Order/1' },
      change: {
        lines: [{ lineItemId: 'gid://shopify/LineItem/1', quantity: 1 }],
        restock: true,
      },
      lines: [
        {
          lineItemId: 'gid://shopify/LineItem/1',
          currentQuantity: 3,
          quantity: 1,
        },
      ],
      before: {
        id: randomUUID(),
        observedAt: '2026-10-12T10:00:00.000Z',
        revision,
        updatedAt: revision,
        orderId: 'gid://shopify/Order/1',
        cancelled: false,
        closed: false,
        totals: {
          subtotal: {
            shop: { amount: '60.00', currencyCode: 'EUR' },
            presentment: { amount: '60.00', currencyCode: 'EUR' },
          },
          total: {
            shop: { amount: '60.00', currencyCode: 'EUR' },
            presentment: { amount: '60.00', currencyCode: 'EUR' },
          },
          outstanding: {
            shop: { amount: '0.00', currencyCode: 'EUR' },
            presentment: { amount: '0.00', currencyCode: 'EUR' },
          },
        },
        lines: [],
        fulfillmentOrders: [],
        complete: true,
      },
      calculation: null,
      authority: { revision: 1, state: 'resolved' as const, connectionId },
      action: {
        schemaVersion: 1 as const,
        id,
        tenantId,
        capability: 'orders.quantity.edit',
        capabilityVersion: '0',
        connectionId,
        target: { kind: 'shopify_order_edit', id },
        parameters: {},
        preconditions: {
          evidenceRefs: [randomUUID()],
          validUntil: '2026-10-12T14:00:00.000Z',
        },
        expectedPostcondition: {},
        risk: 'medium' as const,
        proposedBy: { kind: 'user' as const, id: 'owner' },
        expiresAt: '2026-10-12T14:00:00.000Z',
      },
      decisionId: null,
    };
  }

  it('keeps previews immutable and serializes edits per order', async () => {
    const tenantId = randomUUID();
    const tenant = context(tenantId);
    const connectionId = await connection(tenantId);
    const first = run(tenantId, connectionId);
    await store.save(tenant, first);
    await expect(store.save(tenant, first)).resolves.toMatchObject({
      id: first.id,
    });
    await expect(
      store.save(tenant, {
        ...first,
        change: { ...first.change, restock: false },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    await store.claim(tenant, first);
    await store.claim(tenant, first);
    const second = run(tenantId, connectionId, '2026-10-12T09:05:00Z');
    await store.save(tenant, second);
    // One unsettled edit per order, whatever its revision.
    await expect(store.claim(tenant, second)).rejects.toMatchObject({
      statusCode: 409,
    });
    await store.settle(tenant, first.id);
    await store.claim(tenant, second);
    await store.settle(tenant, second.id);
    // A revision carries at most one edit, even after its claim settled.
    const same = run(tenantId, connectionId);
    await store.save(tenant, same);
    await expect(store.claim(tenant, same)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('sends a commit at most once and lets reconciliation close an unsent operation', async () => {
    const tenantId = randomUUID();
    const tenant = context(tenantId);
    const connectionId = await connection(tenantId);
    const sent = run(tenantId, connectionId);
    await store.save(tenant, sent);
    expect(await store.reserve(tenant, sent.id)).toBe(true);
    expect(await store.reserve(tenant, sent.id)).toBe(false);
    expect(await store.send(tenant, sent.id)).toBe(true);
    expect(await store.send(tenant, sent.id)).toBe(false);
    // A sent commit stays sent until reads reconcile it; it is never withheld afterwards.
    await expect(store.close(tenant, sent.id)).resolves.toMatchObject({
      state: 'sent',
    });
    await store.finish(tenant, sent.id, 'withheld');
    await store.finish(tenant, sent.id, 'accepted');
    const accepted = await store.fence(tenant, sent.id);
    expect(accepted?.state).toBe('accepted');
    expect(accepted?.sentAt).toEqual(expect.any(String));
    await expect(
      database.owner.query(
        "UPDATE shopify_order_edit_fences SET state='sent' WHERE run_id=$1",
        [sent.id],
      ),
    ).rejects.toThrow(/Invalid order edit fence transition/);

    // An interrupted dispatch that never sent is closed, so it cannot send later.
    const interrupted = run(tenantId, connectionId, '2026-10-12T09:10:00Z');
    await store.save(tenant, interrupted);
    expect(await store.reserve(tenant, interrupted.id)).toBe(true);
    await expect(store.close(tenant, interrupted.id)).resolves.toEqual({
      state: 'withheld',
      sentAt: null,
    });
    expect(await store.send(tenant, interrupted.id)).toBe(false);

    // Reconciliation before any dispatch also fences the operation.
    const unstarted = run(tenantId, connectionId, '2026-10-12T09:20:00Z');
    await store.save(tenant, unstarted);
    await expect(store.close(tenant, unstarted.id)).resolves.toMatchObject({
      state: 'withheld',
    });
    expect(await store.reserve(tenant, unstarted.id)).toBe(false);

    await store.hint(tenant, connectionId, sent.id);
    await store.hint(tenant, connectionId, sent.id);
    const hints = await database.owner.query(
      'SELECT capabilities FROM connector_refresh_hints WHERE tenant_id=$1',
      [tenantId],
    );
    expect(hints.rows).toEqual([
      { capabilities: ['orders.read', 'fulfillment.read'] },
    ]);
  });

  it('keeps edits, claims, fences and evidence inside their tenant', async () => {
    const tenantId = randomUUID();
    const tenant = context(tenantId);
    const connectionId = await connection(tenantId);
    const edit = run(tenantId, connectionId);
    await store.save(tenant, edit);
    await store.claim(tenant, edit);
    await store.reserve(tenant, edit.id);
    await store.record(tenant, connectionId, {
      id: randomUUID(),
      kind: 'observation',
      observedAt: '2026-10-12T10:00:00.000Z',
      document: { orderId: 'gid://shopify/Order/1' },
    });
    const other = context(randomUUID());
    expect(await store.get(other, edit.id)).toBeNull();
    expect(await store.fence(other, edit.id)).toBeNull();
    expect(await store.open(other)).toEqual([]);
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [
        other.tenantId,
      ]);
      for (const table of [
        'shopify_order_edits',
        'shopify_order_edit_claims',
        'shopify_order_edit_fences',
        'shopify_order_edit_evidence',
      ]) {
        const rows = await client.query(
          `SELECT count(*)::int AS count FROM ${table}`,
        );
        expect(rows.rows[0]).toEqual({ count: 0 });
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // The runtime role cannot rewrite intent or delete history.
    await expect(
      runtime.query('DELETE FROM shopify_order_edit_fences'),
    ).rejects.toThrow(/permission denied/);
  });
});
