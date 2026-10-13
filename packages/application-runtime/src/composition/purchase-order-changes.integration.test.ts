import { randomUUID } from 'node:crypto';

import { createAuditLog } from '@luma/audit/composition';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { createTenantDatabase } from '@luma/platform/composition';
import type { PurchaseOrderChange } from '@luma/procurement';
import {
  createProcurement,
  createPurchaseOrderChanges,
} from '@luma/procurement/composition';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createMigratedDatabase } from '../test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'verified purchasing revisions on PostgreSQL',
  () => {
    it('atomically appends old/new line snapshots and audit, prevents intent edits and isolates tenants', async () => {
      const db = await createMigratedDatabase(databaseUrl!);
      const role = `revisions_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: databaseUrl });
      let runtime: Pool | undefined;
      try {
        const password = randomUUID();
        await admin.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
        );
        await admin.query(`GRANT luma_desk,luma_audit TO "${role}"`);
        const url = new URL(db.owner.options.connectionString!);
        url.username = role;
        url.password = password;
        runtime = new Pool({ connectionString: url.toString() });
        const database = createTenantDatabase(runtime);
        const tenantId = randomUUID(),
          otherTenant = randomUUID(),
          userId = randomUUID(),
          supplierId = randomUUID(),
          orderId = randomUUID(),
          lineId = randomUUID(),
          connectionId = randomUUID();
        for (const tenant of [tenantId, otherTenant])
          await db.owner.query(
            "INSERT INTO organizations(id,name,slug,status,created_at) VALUES($1,'Shop',$2,'active',now())",
            [tenant, tenant],
          );
        const context = makeTenantContext(
          { userId, sessionId: randomUUID() },
          {
            id: tenantId,
            name: 'Shop',
            slug: 'shop',
            dataRegion: 'EU',
            status: 'active',
          },
          builtInMembership(
            { id: randomUUID(), organizationId: tenantId, userId },
            'owner',
          ),
          randomUUID(),
        );
        const procurement = createProcurement(
          database,
          async (c) => c,
          createAuditLog,
        );
        await procurement.createSupplier(context, {
          id: supplierId,
          name: 'Supplier',
          externalReferences: [],
        });
        const draft = await procurement.createOrder(context, {
          id: orderId,
          supplierId,
          reference: 'PO-1',
          authority: 'luma',
          externalReferences: [],
          origin: {},
          lines: [
            {
              id: lineId,
              sku: 'SKU-1',
              description: 'Item',
              quantity: 12,
              unit: 'each',
            },
          ],
        });
        const order = await procurement.transition(context, orderId, {
          id: randomUUID(),
          expectedRevision: draft.revision,
          status: 'open',
          reason: 'Reviewed',
        });
        const now = new Date().toISOString();
        const source: PurchaseOrderChange['provider']['expected'] = {
          supplier: { externalId: '10', scopeKey: 'global' },
          orderNumber: 'PO-50',
          lumaOrderId: orderId,
          status: 'released',
          requestedDeliveryDate: '2026-10-20',
          confirmed: false,
          createdAt: now,
          lines: [
            {
              id: { externalId: '500', scopeKey: '50' },
              sku: { externalId: '1', scopeKey: 'global' },
              itemNumber: 'SKU-1',
              quantity: { amount: '12', unit: 'each' },
              deliveredQuantity: '0',
              confirmedQuantity: null,
              confirmedDeliveryDate: null,
              confirmed: false,
              requestedDeliveryDate: '2026-10-20',
            },
          ],
        };
        const change: PurchaseOrderChange = {
          id: randomUUID(),
          tenantId,
          purchaseOrderId: orderId,
          connectionId,
          actionId: randomUUID(),
          decisionId: randomUUID(),
          request: {
            id: randomUUID(),
            expectedRevision: 2,
            reason: 'Confirmed remainder revised',
            operation: { kind: 'update_line', lineId, quantity: 6 },
          },
          requestDigest: 'frozen',
          requestedBy: userId,
          requestedAt: now,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          state: 'uncertain',
          baseline: order,
          proposed: {
            ...order,
            revision: 3,
            lines: [{ ...order.lines[0]!, quantity: 6 }],
          },
          provider: {
            order: { externalId: '50', scopeKey: 'global' },
            expected: structuredClone(source),
            operation: {
              kind: 'update_line',
              line: { externalId: '500', scopeKey: '50' },
              quantity: 6,
            },
          },
          affectsCommitments: true,
          decidedBy: userId,
          verifiedAt: null,
          observationRefs: [],
          failure: null,
        };
        await database.transaction(tenantId, (tx) =>
          tx
            .query(
              'INSERT INTO procurement_order_changes(tenant_id,id,purchase_order_id,state,document) VALUES($1,$2,$3,$4,$5)',
              [tenantId, change.id, orderId, change.state, change],
            )
            .then(() => {}),
        );
        await expect(
          database.transaction(tenantId, (tx) =>
            tx
              .query(
                "UPDATE procurement_order_changes SET document=jsonb_set(document,'{request,reason}','\"Changed after approval\"') WHERE id=$1",
                [change.id],
              )
              .then(() => {}),
          ),
        ).rejects.toThrow('intent is immutable');
        source.lines[0]!.quantity.amount = '6';
        const observationId = randomUUID();
        const service = createPurchaseOrderChanges(database, createAuditLog, {
          commitments: {
            order: async () => {
              throw Error('Not used by verification');
            },
            refresh: async () => {},
          },
          purchasing: {
            connections: async () => [],
            suppliers: async () => ({
              ok: true,
              value: { items: [], nextCursor: null },
            }),
            orders: async () => ({
              ok: true,
              value: [
                {
                  observationId,
                  observedAt: new Date().toISOString(),
                  externalId: '50',
                  scopeKey: 'global',
                  data: source,
                },
              ],
            }),
          },
          admission: null,
          refreshContext: async (c) => c,
          principal: async () => context,
          released: async () => true,
          canRevise: async () => true,
        });
        expect((await service.verify(context, change.id)).outcome).toBe(
          'passed',
        );
        expect((await service.verify(context, change.id)).outcome).toBe(
          'passed',
        );
        const detail = await procurement.detail(context, orderId);
        expect(detail.order.lines[0]!.quantity).toBe(6);
        expect(detail.order.revision).toBe(3);
        expect(
          (await createAuditLog(database).list(tenantId, orderId)).filter(
            (e) => e.eventType === 'purchase_order.revised',
          ),
        ).toHaveLength(1);
        await database.transaction(tenantId, async (tx) => {
          const rows = await tx.query<{
            document: { order: { lines: { quantity: number }[] } };
          }>(
            'SELECT document FROM procurement_order_revisions ORDER BY revision',
          );
          expect(
            rows.rows.map((r) => r.document.order.lines[0]!.quantity),
          ).toEqual([12, 6]);
        });
        await database.transaction(otherTenant, async (tx) => {
          expect(
            (await tx.query('SELECT * FROM procurement_order_changes')).rows,
          ).toEqual([]);
          expect(
            (await tx.query('SELECT * FROM procurement_order_revisions')).rows,
          ).toEqual([]);
        });
        await expect(
          database.transaction(tenantId, (tx) =>
            tx
              .query(
                'UPDATE procurement_order_revisions SET document=document WHERE purchase_order_id=$1',
                [orderId],
              )
              .then(() => {}),
          ),
        ).rejects.toThrow('permission denied');
      } finally {
        await runtime?.end();
        await db.drop();
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        await admin.end();
      }
    }, 60_000);
  },
);
