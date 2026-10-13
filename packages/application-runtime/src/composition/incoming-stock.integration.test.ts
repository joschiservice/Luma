import { randomUUID } from 'node:crypto';

import { createCorrectionStore } from '@luma/app-shopify';
import { createAuditLog } from '@luma/audit/composition';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { createTenantDatabase } from '@luma/platform/composition';
import {
  createIncomingStockReader,
  createProcurement,
} from '@luma/procurement/composition';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createMigratedDatabase } from '../test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  'incoming supplier stock and receipt claims on PostgreSQL',
  () => {
    it('reads current outstanding arrivals with RLS and permanently fences an uncertain receipt across stock revisions', async () => {
      const db = await createMigratedDatabase(databaseUrl!);
      const role = `incoming_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: databaseUrl });
      let runtime: Pool | undefined;
      try {
        const password = randomUUID();
        await admin.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
        );
        await admin.query(
          `GRANT luma_desk,luma_audit,luma_connectors,luma_case_reader,luma_execution TO "${role}"`,
        );
        const url = new URL(db.owner.options.connectionString!);
        url.username = role;
        url.password = password;
        runtime = new Pool({ connectionString: url.toString(), max: 3 });
        const database = createTenantDatabase(runtime);
        const tenantId = randomUUID(),
          otherTenant = randomUUID(),
          skuId = randomUUID(),
          locationId = randomUUID(),
          connectionId = randomUUID(),
          supplierId = randomUUID(),
          orderId = randomUUID(),
          lineId = randomUUID(),
          receiptId = randomUUID();
        const now = new Date('2026-10-13T12:00:00.000Z');
        const context = (tenant: string) => {
          const userId = randomUUID();

          return makeTenantContext(
            { userId, sessionId: randomUUID() },
            {
              id: tenant,
              name: 'Shop',
              slug: 'shop',
              dataRegion: 'EU',
              status: 'active',
            },
            builtInMembership(
              { id: randomUUID(), organizationId: tenant, userId },
              'owner',
            ),
            randomUUID(),
          );
        };
        const buyer = context(tenantId);
        for (const tenant of [tenantId, otherTenant])
          await db.owner.query(
            "INSERT INTO organizations(id,name,slug,status,created_at) VALUES($1,'Shop',$2,'active',now())",
            [tenant, tenant],
          );
        for (const [id, kind, key] of [
          [skuId, 'sku', 'TOTE'],
          [locationId, 'location', 'Warehouse'],
        ])
          await db.owner.query(
            'INSERT INTO inventory_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,$3,$4)',
            [id, tenantId, kind, key],
          );
        await db.owner.query(
          'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
          [
            tenantId,
            connectionId,
            {
              id: connectionId,
              tenantId,
              version: 1,
              status: 'active',
              provider: 'shopify',
              target: { kind: 'shopify', shop: 'test.myshopify.com' },
              label: 'Shopify',
              permissions: ['inventory.read'],
              granted: ['inventory.read'],
            },
            'fixture',
          ],
        );
        const procurement = createProcurement(
          database,
          async (ctx) => ctx,
          createAuditLog,
        );
        await procurement.createSupplier(buyer, {
          id: supplierId,
          name: 'Supplier',
          externalReferences: [],
        });
        await procurement.createOrder(buyer, {
          id: orderId,
          supplierId,
          reference: 'PO-1',
          authority: 'luma',
          externalReferences: [],
          origin: {},
          lines: [
            {
              id: lineId,
              sku: 'TOTE',
              description: 'Tote',
              quantity: 100,
              unit: 'each',
              locationId,
            },
          ],
        });
        await procurement.transition(buyer, orderId, {
          id: randomUUID(),
          expectedRevision: 1,
          status: 'open',
          reason: 'Approved email submission',
        });
        const receipt = {
          id: receiptId,
          tenantId,
          purchaseOrderId: orderId,
          lineId,
          kind: 'received',
          quantity: 40,
          date: null,
          text: null,
          source: {
            kind: 'manual_receipt',
            receivedAt: now.toISOString(),
            condition: 'mixed',
            reason: 'Partial delivery',
            evidence: ['DN-1'],
          },
          status: 'confirmed',
          reviewReasons: [],
          supersedes: null,
          recordedAt: now.toISOString(),
          recordedBy: { kind: 'user', id: buyer.actor.id },
          review: null,
        };
        await db.owner.query(
          'INSERT INTO procurement_commitments(tenant_id,id,purchase_order_id,source_key,document,recorded_at) VALUES($1,$2,$3,$4,$5,$6)',
          [tenantId, receiptId, orderId, receiptId, receipt, now],
        );
        const reader = createIncomingStockReader(database, () => now);
        expect(await reader(buyer, { skuIds: [skuId] })).toMatchObject({
          items: [
            {
              quantity: 60,
              locationId,
              source: 'purchase_order',
              dateStatus: 'unknown',
            },
          ],
          truncated: false,
        });
        expect(
          (await reader(context(otherTenant), { skuIds: [skuId] })).items,
        ).toEqual([]);
        await database.transaction(tenantId, async (tx) => {
          expect(
            (
              await tx.query(
                'SELECT id FROM procurement_commitments WHERE tenant_id=$1',
                [otherTenant],
              )
            ).rows,
          ).toEqual([]);
        });
        const store = createCorrectionStore(database);
        const run = (revision: string): Parameters<typeof store.save>[1] => {
          const id = randomUUID();

          return {
            id,
            tenantId,
            target: {
              positionId: randomUUID(),
              connectionId,
              sourceConnectionId: connectionId,
              receipt: {
                purchaseOrderId: orderId,
                lineId,
                commitmentId: receiptId,
                damagedCommitmentId: null,
                baselineAvailable: 12,
                quantity: 40,
                cumulativeGood: 40,
              },
            },
            choice: { capability: 'inventory.available.reconcile' },
            before: {
              id: randomUUID(),
              observedAt: now.toISOString(),
              revision,
              targetRevision: revision,
              inventoryItemId: 'gid://shopify/InventoryItem/1',
              locationId: 'gid://shopify/Location/1',
              locationName: 'Warehouse',
              available: 12,
              tracked: true,
              complete: true,
              source: {
                connectionId,
                label: 'Manual receipt',
                observationId: receiptId,
                observedAt: now.toISOString(),
                revision: 'receipt-1',
                available: 52,
              },
            },
            action: {
              schemaVersion: 1,
              id,
              tenantId,
              capability: 'inventory.available.reconcile',
              capabilityVersion: '0',
              connectionId,
              target: { kind: 'shopify_inventory_correction', id },
              parameters: {},
              preconditions: {
                evidenceRefs: [receiptId],
                validUntil: new Date(now.getTime() + 3600000).toISOString(),
              },
              expectedPostcondition: { available: 52 },
              risk: 'medium',
              proposedBy: { kind: 'user', id: buyer.actor.id },
              expiresAt: new Date(now.getTime() + 3600000).toISOString(),
            },
            decisionId: null,
          };
        };
        const first = await store.save(buyer, run('stock-1'));
        await store.claim(buyer, first);
        expect(await store.claim(buyer, first)).toBeUndefined();
        const next = await store.save(buyer, run('stock-2'));
        await expect(store.claim(buyer, next)).rejects.toThrow(
          /already has a stock booking/,
        );
        expect(await store.get(context(otherTenant), first.id)).toBeNull();
        await procurement.transition(buyer, orderId, {
          id: randomUUID(),
          expectedRevision: 2,
          status: 'cancelled',
          reason: 'Remainder cancelled',
        });
        expect((await reader(buyer, { skuIds: [skuId] })).items).toEqual([]);
      } finally {
        await runtime?.end();
        await db.drop();
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        await admin.end();
      }
    }, 60_000);
  },
);
