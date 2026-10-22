import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { createUpdateStore } from '@luma/app-starshipit';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase } from './test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const userId = '00000000-0000-4000-8000-0000000000ad';

const context = (tenantId: string) =>
  makeTenantContext(
    { userId, sessionId: 'session' },
    {
      id: tenantId,
      name: 'Store',
      slug: 'store',
      dataRegion: 'AU',
      status: 'active',
    },
    builtInMembership(
      { id: 'membership', organizationId: tenantId, userId },
      'owner',
    ),
    randomUUID(),
  );

describe.skipIf(!databaseUrl)('Starshipit update starts on PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let runtime: Pool;
  let store: ReturnType<typeof createUpdateStore>;
  const role = `starshipit_starts_${randomUUID().replaceAll('-', '')}`;

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
    // One connection: a start that held it while running could never open its own transactions.
    runtime = new Pool({ connectionString: url.toString(), max: 1 });
    store = createUpdateStore(createTenantDatabase(runtime));
  });

  afterAll(async () => {
    await runtime?.end();
    await database?.owner.query(`DROP OWNED BY "${role}"`).catch(() => {});
    await database?.drop();
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  });

  /** Saves a reviewed update in a new workspace and returns its tenant context and ID. */
  async function update() {
    const tenantId = randomUUID();
    const connectionId = randomUUID();
    const id = randomUUID();
    await database.owner.query(
      "INSERT INTO organizations(data_region,id,name,slug,status,write_mode,created_at) VALUES('AU',$1,'Starts',$2,'active','writes_enabled',now())",
      [tenantId, `starts-${tenantId}`],
    );
    await database.owner.query(
      'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
      [
        tenantId,
        connectionId,
        {
          id: connectionId,
          tenantId,
          version: 1,
          status: 'active',
          provider: 'starshipit',
          target: { kind: 'starshipit' },
          label: 'Starshipit',
          permissions: ['orders.read'],
          granted: ['orders.read'],
        },
        'encrypted-fixture',
      ],
    );
    const tenant = context(tenantId);
    const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
    await store.save(tenant, {
      id,
      tenantId,
      connectionId,
      orderId: '1',
      revision: 'revision',
      observedAt: new Date().toISOString(),
      lines: [{ lineItemId: '11', currentQuantity: 3, quantity: 2 }],
      authority: {
        revision: 1,
        connectionId,
        observationId: randomUUID(),
        canonicalOrderId: randomUUID(),
      },
      action: {
        schemaVersion: 1,
        id,
        tenantId,
        connectionId,
        capability: 'orders.quantity.update',
        capabilityVersion: '0',
        target: { kind: 'starshipit_order_update', id },
        parameters: {},
        preconditions: { evidenceRefs: [], validUntil: expiresAt },
        expectedPostcondition: {},
        risk: 'medium',
        proposedBy: { kind: 'user', id: userId },
        expiresAt,
      },
    });

    return { tenant, id };
  }

  it('runs concurrent starts one after another without holding a connection', async () => {
    const { tenant, id } = await update();
    const events: string[] = [];
    // Each start reads the update while it runs, and outlives its first lease, which renewal extends.
    const start = (name: string) =>
      store.exclusive(
        tenant,
        id,
        async () => {
          events.push(`${name} started`);
          expect(await store.get(tenant, id)).not.toBeNull();
          await delay(200);
          events.push(`${name} finished`);
        },
        { leaseMs: 90, pollMs: 10 },
      );

    await Promise.all([start('first'), start('second')]);

    expect(events).toEqual([
      expect.stringMatching(/started$/),
      expect.stringMatching(/finished$/),
      expect.stringMatching(/started$/),
      expect.stringMatching(/finished$/),
    ]);
    expect(events[0]!.split(' ')[0]).toBe(events[1]!.split(' ')[0]);
  });

  it('refuses a start while another one keeps the lease, and frees the update afterwards', async () => {
    const { tenant, id } = await update();
    let finish = () => {};
    const running = store.exclusive(
      tenant,
      id,
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    await expect
      .poll(
        async () =>
          (
            await database.owner.query(
              'SELECT start_token FROM starshipit_order_updates WHERE id=$1',
              [id],
            )
          ).rows[0]?.start_token,
      )
      .not.toBeNull();

    await expect(
      store.exclusive(tenant, id, async () => 'second', {
        waitMs: 50,
        pollMs: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    finish();
    await running;
    await expect(store.exclusive(tenant, id, async () => 'next')).resolves.toBe(
      'next',
    );
  });

  it('takes over a lease left by a start that crashed', async () => {
    const { tenant, id } = await update();
    await database.owner.query(
      "UPDATE starshipit_order_updates SET start_token=$2,start_lease_until=now()-interval '1 second' WHERE id=$1",
      [id, randomUUID()],
    );

    await expect(
      store.exclusive(tenant, id, async () => 'resumed', { waitMs: 0 }),
    ).resolves.toBe('resumed');
  });
});
