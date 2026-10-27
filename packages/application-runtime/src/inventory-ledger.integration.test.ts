import { randomUUID } from 'node:crypto';

import { createAuditLog } from '@luma/audit/composition';
import type { TenantContext } from '@luma/identity';
import { makeTenantContext, PermissionSet } from '@luma/identity';
import { LedgerError } from '@luma/inventory';
import {
  createLedgerStore,
  createNativeStockServices,
  createNativeStockStore,
} from '@luma/inventory/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInventoryLedgerRuntime } from './composition/inventory-ledger.js';
import { createMigratedDatabase } from './test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

/** Sales' redacted demand for one native order, as the store's owner port returns it. */
type NativeStockDemand = NonNullable<
  Awaited<ReturnType<Parameters<typeof createNativeStockStore>[2]['demand']>>
>;

/** Exact six-decimal units, as the ledger stores them. */
const units = (value: string) => {
  const [whole, fraction = ''] = value.split('.');

  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
};

/** Formats exact units like PostgreSQL `trim_scale`. */
const decimal = (value: bigint) => {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const fraction = String(absolute % 1_000_000n)
    .padStart(6, '0')
    .replace(/0+$/, '');

  return `${sign}${absolute / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
};

/** Retries a stock command that lost an expected-version race, as callers do after a stale failure. */
async function retryStale<T>(
  attempt: () => Promise<T>,
  counter: { stale: number },
) {
  for (let tries = 0; tries < 500; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof LedgerError && error.code === 'stale'))
        throw error;
      counter.stale++;
    }
  }
  throw new Error('A stock command kept losing its expected-version race.');
}

describe.skipIf(!databaseUrl)(
  'inventory ledger stores under concurrency',
  () => {
    const login = `luma_ledger_test_${randomUUID().replaceAll('-', '')}`;
    const tenantId = randomUUID();
    const userId = randomUUID();
    const connectionId = randomUUID();
    let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
    let admin: Pool;
    let owner: Pool;
    let runtime: Pool;

    const context = (): TenantContext =>
      makeTenantContext(
        { userId, sessionId: randomUUID() },
        {
          id: tenantId,
          name: 'Ledger',
          slug: 'ledger',
          status: 'active',
          dataRegion: 'EU',
        },
        {
          id: randomUUID(),
          organizationId: tenantId,
          userId,
          role: {
            id: 'role',
            key: 'custom',
            name: 'Custom',
            builtIn: false,
            revision: 1,
          },
          permissions: new PermissionSet([
            'inventory.read',
            'inventory.manage',
            'orders.read',
          ]),
        },
        randomUUID(),
      );

    const identity = {
      refreshContext: async (value: TenantContext) => value,
      resolveWorkflowContext: async (): Promise<TenantContext> => {
        throw new Error('Reviewed stock is not exercised here.');
      },
    };

    beforeAll(async () => {
      database = await createMigratedDatabase(databaseUrl!);
      owner = database.owner;
      admin = new Pool({ connectionString: databaseUrl });
      const name = (
        await owner.query<{ name: string }>('SELECT current_database() AS name')
      ).rows[0]!.name;
      const password = randomUUID();
      // The API login reaches Inventory through the Sales group role; it cannot bypass RLS.
      await admin.query(
        `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(`GRANT luma_sales TO "${login}"`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${name}`;
      url.username = login;
      url.password = password;
      runtime = new Pool({ connectionString: url.toString(), max: 16 });

      await owner.query(
        "INSERT INTO organizations(id,name,slug,status,data_region,created_at) VALUES($1,'Ledger',$2,'active','EU',now())",
        [tenantId, `ledger-${tenantId}`],
      );
      await owner.query(
        'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
        [
          tenantId,
          connectionId,
          {
            id: connectionId,
            tenantId,
            version: 1,
            status: 'active',
            target: { kind: 'shopify' },
            label: 'Fixture',
            permissions: [],
            granted: ['fulfillment.read', 'inventory.read'],
          },
          'secret',
        ],
      );
    });

    afterAll(async () => {
      await runtime?.end();
      await database?.drop();
      await admin?.query(`DROP ROLE IF EXISTS "${login}"`);
      await admin?.end();
    });

    /** Creates a SKU and location with a reviewed zero opening, so movements may post to the pool. */
    async function openedPool() {
      const skuId = randomUUID();
      const locationId = randomUUID();
      for (const [id, kind] of [
        [skuId, 'sku'],
        [locationId, 'location'],
      ])
        await owner.query(
          'INSERT INTO inventory_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,$3,$4)',
          [id, tenantId, kind, `${kind}-${id}`],
        );
      const reviewId = randomUUID();
      const key = `opening:${skuId}:${locationId}`;
      const hash = 'f'.repeat(64);
      await owner.query(
        "INSERT INTO inventory_ledger_reviews(tenant_id,id,command_key,intent_hash,command_hash,command_document,source_bindings,prepared_by) VALUES($1,$2,$3,$4,$4,$5,'[]','preparer')",
        [
          tenantId,
          reviewId,
          key,
          hash,
          {
            id: reviewId,
            key,
            purpose: 'opening',
            reason: 'Fixture opening',
            effectiveAt: null,
            evidence: [],
            postings: [],
            expected: [],
          },
        ],
      );
      await owner.query(
        "UPDATE inventory_ledger_reviews SET state='approved',reviewed_by='reviewer',reviewed_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantId, reviewId],
      );
      const recordedAt = new Date().toISOString();
      await owner.query(
        'INSERT INTO inventory_ledger_commands(tenant_id,command_key,command_hash,receipt) VALUES($1,$2,$3,$4)',
        [
          tenantId,
          key,
          hash,
          {
            id: reviewId,
            key,
            commandHash: hash,
            entryId: null,
            reviewId,
            recordedAt,
            accounts: [],
          },
        ],
      );
      await owner.query(
        'INSERT INTO inventory_ledger_openings(tenant_id,sku_id,location_id,unit,review_id,command_key,entry_id,recorded_at) VALUES($1,$2,$3,$4,$5,$6,NULL,$7)',
        [tenantId, skuId, locationId, 'each', reviewId, key, recordedAt],
      );

      return { skuId, locationId, unit: 'each' };
    }

    type StockPool = Awaited<ReturnType<typeof openedPool>>;

    const ledger = () =>
      createInventoryLedgerRuntime(createTenantDatabase(runtime), identity);
    const store = () =>
      createLedgerStore(createTenantDatabase(runtime), createAuditLog);

    /** Reads the current accounts through the store, without locking them. */
    const current = (
      pool: StockPool,
      states: ('available' | 'adjustment' | 'reserved')[],
    ) =>
      store().transaction(context(), (tx) =>
        tx.accounts(
          states.map((state) => ({ ...pool, state })),
          false,
        ),
      );

    /** A movement from the adjustment counterparty into available stock at the current versions. */
    async function receive(
      pool: StockPool,
      quantity: string,
      key = randomUUID(),
    ) {
      const accounts = await current(pool, ['available', 'adjustment']);

      return {
        id: randomUUID(),
        key,
        purpose: 'movement' as const,
        reason: 'Concurrent receipt',
        effectiveAt: new Date(Date.now() - 60_000).toISOString(),
        evidence: [],
        postings: [
          { account: { ...pool, state: 'available' as const }, quantity },
          {
            account: { ...pool, state: 'adjustment' as const },
            quantity: `-${quantity}`,
          },
        ],
        expected: accounts.map((account) => ({
          account: account.address,
          balance: account.balance,
          version: account.version,
        })),
      };
    }

    /** Reads one account's balance, version and journal totals as the database owner. */
    async function journal(pool: StockPool, state: string) {
      return (
        await owner.query<{
          id: string;
          balance: string;
          version: string;
          postings: string;
          total: string;
          versions: string;
        }>(
          `SELECT a.id,trim_scale(a.balance)::text AS balance,a.version::text AS version,count(p.*)::text AS postings,
          trim_scale(COALESCE(sum(p.quantity),0))::text AS total,count(DISTINCT p.account_version)::text AS versions
         FROM inventory_ledger_accounts a LEFT JOIN inventory_ledger_postings p ON p.tenant_id=a.tenant_id AND p.account_id=a.id
         WHERE a.tenant_id=$1 AND a.sku_id=$2 AND a.location_id=$3 AND a.unit=$4 AND a.state=$5 GROUP BY a.tenant_id,a.id`,
          [tenantId, pool.skuId, pool.locationId, pool.unit, state],
        )
      ).rows[0]!;
    }

    const count = async (sql: string, values: unknown[]) =>
      Number(
        (await owner.query<{ count: string }>(sql, values)).rows[0]!.count,
      );

    it('posts once under concurrent retries', async () => {
      const pool = await openedPool();
      const command = await receive(pool, '7.25');
      const service = ledger();

      const receipts = await Promise.all(
        Array.from({ length: 12 }, () => service.post(context(), command)),
      );

      expect(new Set(receipts.map((receipt) => receipt.entryId))).toEqual(
        new Set([command.id]),
      );
      expect(receipts.every((receipt) => receipt.key === command.key)).toBe(
        true,
      );
      expect(
        await count(
          'SELECT count(*) FROM inventory_ledger_entries WHERE tenant_id=$1 AND command_key=$2',
          [tenantId, command.key],
        ),
      ).toBe(1);
      expect(
        await count(
          'SELECT count(*) FROM audit_entries WHERE tenant_id=$1 AND event_key=$2',
          [tenantId, `inventory-ledger:posted:${command.key}`],
        ),
      ).toBe(1);
      expect(await journal(pool, 'available')).toMatchObject({
        balance: '7.25',
        version: '1',
        postings: '1',
        total: '7.25',
      });
      expect(await journal(pool, 'adjustment')).toMatchObject({
        balance: '-7.25',
        version: '1',
        total: '-7.25',
      });
    });

    it('rejects a retry that reuses the key with different stock', async () => {
      const pool = await openedPool();
      const command = await receive(pool, '2');
      const service = ledger();
      await service.post(context(), command);

      await expect(
        service.post(context(), {
          ...command,
          postings: [
            { ...command.postings[0]!, quantity: '3' },
            { ...command.postings[1]!, quantity: '-3' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'changed_command' });
      expect((await journal(pool, 'available')).balance).toBe('2');
    });

    it('checkpoint equals sum after concurrent writers', async () => {
      const pool = await openedPool();
      const service = ledger();
      const writers = 8;
      const perWriter = 14;
      const counter = { stale: 0 };
      const quantities = Array.from({ length: writers }, (_, writer) =>
        Array.from(
          { length: perWriter },
          (_, index) => `${writer * perWriter + index + 1}.5`,
        ),
      );

      const keys: string[] = [];

      await Promise.all(
        quantities.map(async (list) => {
          for (const quantity of list) {
            // A stable key per intended receipt keeps a retried post from booking it twice.
            const key = randomUUID();
            keys.push(key);
            await retryStale(
              async () =>
                service.post(context(), await receive(pool, quantity, key)),
              counter,
            );
          }
        }),
      );

      const total = quantities
        .flat()
        .reduce((sum, quantity) => sum + units(quantity), 0n);
      const entries = writers * perWriter;
      const available = await journal(pool, 'available');
      expect(available).toMatchObject({
        balance: decimal(total),
        version: String(entries),
        postings: String(entries),
        versions: String(entries),
        total: decimal(total),
      });
      expect(await journal(pool, 'adjustment')).toMatchObject({
        balance: decimal(-total),
        version: String(entries),
        total: decimal(-total),
      });
      expect(
        await count(
          'SELECT count(*) FROM audit_entries WHERE tenant_id=$1 AND event_key=ANY($2)',
          [tenantId, keys.map((key) => `inventory-ledger:posted:${key}`)],
        ),
      ).toBe(entries);

      // Every hundredth version writes a checkpoint of its exact posting prefix.
      const checkpoint = (
        await owner.query<{ known: string; unknown: string; prefix: string }>(
          `SELECT trim_scale(c.known_quantity)::text AS known,trim_scale(c.unknown_quantity)::text AS unknown,
          (SELECT trim_scale(sum(quantity))::text FROM inventory_ledger_postings p WHERE p.tenant_id=c.tenant_id AND p.account_id=c.account_id AND p.account_version<=c.version) AS prefix
         FROM inventory_ledger_checkpoints c WHERE c.tenant_id=$1 AND c.account_id=$2 AND c.version=100`,
          [tenantId, available.id],
        )
      ).rows[0];
      expect(checkpoint).toBeDefined();
      expect(checkpoint!.known).toBe(checkpoint!.prefix);
      expect(checkpoint!.unknown).toBe('0');

      // A historical read combines that checkpoint with the later tail.
      const balance = await service.historical(context(), {
        account: { ...pool, state: 'available' },
        effectiveAt: new Date().toISOString(),
        recordedAt: new Date(Date.now() + 1_000).toISOString(),
        maximumVersion: String(entries),
      });
      expect(balance).toMatchObject({
        knownQuantity: decimal(total),
        unknownQuantity: '0',
        recordedVersion: String(entries),
      });
    }, 120_000);

    describe('native reservations', () => {
      /** Places the location in the reviewed shadow phase from its approved transition. */
      async function shadowScope(locationId: string) {
        const reviewId = randomUUID();
        const transitionId = randomUUID();
        const binding = {
          scopeVersion: '0',
          authorityRevision: '0',
          locationId,
          connectionId,
        };
        await owner.query(
          "INSERT INTO inventory_stock_ownership_reviews(tenant_id,id,command_key,intent_hash,from_mode,to_mode,binding,reason,prepared_by) VALUES($1,$2,$3,$4,'observe','shadow',$5,'Fixture shadow','preparer')",
          [tenantId, reviewId, `shadow:${locationId}`, 'e'.repeat(64), binding],
        );
        await owner.query(
          "UPDATE inventory_stock_ownership_reviews SET state='approved',reviewed_by='reviewer',reviewed_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenantId, reviewId],
        );
        await owner.query(
          "INSERT INTO inventory_stock_ownership_transitions(tenant_id,id,location_id,connection_id,version,review_id,command_key,from_mode,to_mode,binding,actor_id,reviewer_id) VALUES($1,$2,$3,$4,1,$5,$6,'observe','shadow',$7,'preparer','reviewer')",
          [
            tenantId,
            transitionId,
            locationId,
            connectionId,
            reviewId,
            `transition:${locationId}`,
            binding,
          ],
        );
        await owner.query(
          "INSERT INTO inventory_stock_ownership_scopes(tenant_id,location_id,connection_id,version,mode,authority_revision,last_transition_id) VALUES($1,$2,$3,1,'shadow',0,$4)",
          [tenantId, locationId, connectionId, transitionId],
        );
      }

      /** Creates a mapped native order with one line and a fresh complete read showing no shipments. */
      async function order(skuId: string, quantity: string) {
        const orderId = randomUUID();
        const lineId = randomUUID();
        const observationId = randomUUID();
        const mappingId = randomUUID();
        const observedAt = new Date().toISOString();
        for (const [id, kind] of [
          [orderId, 'order'],
          [lineId, 'order_line'],
        ])
          await owner.query(
            'INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,$3,$4)',
            [id, tenantId, kind, `${kind}-${id}`],
          );
        await owner.query(
          'INSERT INTO connector_observations(id,tenant_id,connection_id,ingest_key,document) VALUES($1,$2,$3,$4,$5)',
          [
            observationId,
            tenantId,
            connectionId,
            `order-${orderId}`,
            {
              capability: 'fulfillment.read',
              observation: {
                observedAt,
                source: { tenantId, connectionId },
              },
            },
          ],
        );
        await owner.query(
          "INSERT INTO connector_source_mappings(id,tenant_id,connection_id,resource,scope_key,external_id,canonical_id,observation_id,method,actor_id) VALUES($1,$2,$3,'order','',$4,$5,$6,'fixture','fixture')",
          [
            mappingId,
            tenantId,
            connectionId,
            `order-${orderId}`,
            orderId,
            observationId,
          ],
        );
        const readId = randomUUID();
        await owner.query(
          'INSERT INTO inventory_native_shipment_reads(tenant_id,id,connection_id,order_id,observed_at,complete,document) VALUES($1,$2,$3,$4,$5,true,$6)',
          [
            tenantId,
            readId,
            connectionId,
            orderId,
            observedAt,
            {
              id: readId,
              connectionId,
              orderId,
              orderExternalId: `order-${orderId}`,
              orderScopeKey: '',
              observedAt,
              complete: true,
              mappingVersion: '1',
              bindings: [
                {
                  resource: 'order',
                  externalId: `order-${orderId}`,
                  scopeKey: '',
                  canonicalId: orderId,
                  mappingId,
                },
              ],
              shipments: [],
            },
          ],
        );
        const demand: NativeStockDemand = {
          orderId,
          version: 1,
          status: 'open',
          connectionId,
          lines: [
            {
              id: lineId,
              skuId,
              skuCode: null,
              title: null,
              unit: 'each',
              currentQuantity: quantity,
            },
          ],
        };

        return { orderId, lineId, readId, demand };
      }

      /** Native stock services over the real store; Sales demand comes from the order fixtures. */
      function services(demands: Map<string, NativeStockDemand>) {
        return createNativeStockServices({
          store: createNativeStockStore(
            createTenantDatabase(runtime),
            createAuditLog,
            {
              demand: async (_db, _context, orderId) =>
                demands.get(orderId) ?? null,
              authorityRevision: async () => 0,
              unsettled: async () => false,
            },
          ),
          refreshContext: identity.refreshContext,
          reviewerContext: identity.resolveWorkflowContext,
        });
      }

      /** An allocation of the order line at the current available version. */
      async function allocation(
        pool: StockPool,
        placed: Awaited<ReturnType<typeof order>>,
        quantity: string,
        key: string,
        reservationId: string,
      ) {
        const [available] = await current(pool, ['available']);

        return {
          id: randomUUID(),
          key,
          reservationId,
          orderId: placed.orderId,
          orderLineId: placed.lineId,
          orderVersion: 1,
          connectionId,
          locationId: pool.locationId,
          quantity,
          unit: pool.unit,
          expiresAt: null,
          reservationVersion: null,
          available: {
            balance: available!.balance,
            version: available!.version,
          },
          ownershipVersion: '1',
          authorityRevision: 0,
          shipmentReadId: placed.readId,
        };
      }

      /** Counts the reservations, their remaining units and stored allocation receipts of a pool. */
      async function reservations(pool: StockPool) {
        return (
          await owner.query<{ count: string; remaining: string }>(
            "SELECT count(*)::text AS count,trim_scale(COALESCE(sum(remaining),0))::text AS remaining FROM inventory_native_reservations WHERE tenant_id=$1 AND sku_id=$2 AND location_id=$3 AND state='active'",
            [tenantId, pool.skuId, pool.locationId],
          )
        ).rows[0]!;
      }

      it('allocates once under concurrent retries', async () => {
        const pool = await openedPool();
        await shadowScope(pool.locationId);
        await ledger().post(context(), await receive(pool, '10'));
        const placed = await order(pool.skuId, '3');
        const reserve = services(
          new Map([[placed.orderId, placed.demand]]),
        ).reservations;
        const input = await allocation(
          pool,
          placed,
          '3',
          randomUUID(),
          randomUUID(),
        );

        const results = await Promise.all(
          Array.from({ length: 10 }, () => reserve.allocate(context(), input)),
        );

        expect(results.every((result) => result.allocated === '3')).toBe(true);
        expect(
          new Set(results.map((result) => result.ledger?.entryId)),
        ).toEqual(new Set([input.id]));
        expect(await reservations(pool)).toEqual({
          count: '1',
          remaining: '3',
        });
        expect(
          await count(
            'SELECT count(*) FROM inventory_native_stock_commands WHERE tenant_id=$1 AND command_key=$2',
            [tenantId, input.key],
          ),
        ).toBe(1);
        expect(
          await count(
            "SELECT count(*) FROM inventory_ledger_entries WHERE tenant_id=$1 AND purpose='reservation' AND command_key=$2",
            [tenantId, input.key],
          ),
        ).toBe(1);
        expect((await journal(pool, 'available')).balance).toBe('7');
        expect((await journal(pool, 'reserved')).balance).toBe('3');
      });

      it('never reserves more than available stock under concurrent orders', async () => {
        const pool = await openedPool();
        await shadowScope(pool.locationId);
        await ledger().post(context(), await receive(pool, '5'));
        const placed = await Promise.all(
          Array.from({ length: 8 }, () => order(pool.skuId, '1')),
        );
        const reserve = services(
          new Map(placed.map((value) => [value.orderId, value.demand])),
        ).reservations;
        const counter = { stale: 0 };

        const results = await Promise.all(
          placed.map((value) => {
            const key = randomUUID(),
              reservationId = randomUUID();

            return retryStale(
              async () =>
                reserve.allocate(
                  context(),
                  await allocation(pool, value, '1', key, reservationId),
                ),
              counter,
            );
          }),
        );

        expect(
          results.filter((result) => result.allocated === '1'),
        ).toHaveLength(5);
        expect(
          results.filter(
            (result) => result.allocated === '0' && result.unallocated === '1',
          ),
        ).toHaveLength(3);
        expect(await reservations(pool)).toEqual({
          count: '5',
          remaining: '5',
        });
        expect(await journal(pool, 'available')).toMatchObject({
          balance: '0',
          total: '0',
        });
        expect(await journal(pool, 'reserved')).toMatchObject({
          balance: '5',
          total: '5',
        });
      }, 60_000);
    });
  },
);
