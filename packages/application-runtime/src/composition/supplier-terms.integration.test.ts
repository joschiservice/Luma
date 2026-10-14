import { randomUUID } from 'node:crypto';

import { createAuditLog } from '@luma/audit/composition';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { createTenantDatabase } from '@luma/platform/composition';
import {
  createProcurement,
  createSupplierTerms,
} from '@luma/procurement/composition';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createMigratedDatabase } from '../test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('supplier purchasing terms on PostgreSQL', () => {
  it('commits immutable evidence, audit and retry results together with revision and tenant isolation', async () => {
    const db = await createMigratedDatabase(databaseUrl!);
    const role = `terms_${randomUUID().replaceAll('-', '')}`;
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
        skuId = randomUUID(),
        foreignSku = randomUUID(),
        supplierId = randomUUID();
      const userId = randomUUID();
      const context = (tenant: string) =>
        makeTenantContext(
          { userId, sessionId: randomUUID() },
          {
            id: tenant,
            name: 'Shop',
            slug: 'shop',
            dataRegion: 'AU',
            status: 'active',
          },
          builtInMembership(
            { id: randomUUID(), organizationId: tenant, userId },
            'owner',
          ),
          randomUUID(),
        );
      const buyer = context(tenantId);
      for (const tenant of [tenantId, otherTenant])
        await db.owner.query(
          "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Shop',$2,'active',now())",
          [tenant, tenant],
        );
      for (const [id, tenant] of [
        [skuId, tenantId],
        [foreignSku, otherTenant],
      ])
        await db.owner.query(
          "INSERT INTO inventory_entities(id,tenant_id,kind,reconciliation_key) VALUES($1::uuid,$2::uuid,'sku',$1::uuid::text)",
          [id, tenant],
        );
      const procurement = createProcurement(
        database,
        async (c) => c,
        createAuditLog,
      );
      await procurement.createSupplier(buyer, {
        id: supplierId,
        name: 'Supplier',
        externalReferences: [],
      });
      const service = createSupplierTerms(
        database,
        async (c) => c,
        createAuditLog,
        async () => true,
      );
      const input = {
        id: randomUUID(),
        supplierId,
        skuId,
        expectedRevision: 0,
        values: {
          packSize: 6,
          unitPrice: {
            amount: '4.25',
            currency: 'EUR',
            validFrom: '2026-10-13',
          },
        },
        reason: 'Reviewed quotation',
      };
      const first = await service.save(buyer, input);
      expect(await service.save(buyer, input)).toEqual(first);
      expect((await service.list(context(otherTenant))).items).toEqual([]);
      await expect(
        service.save(buyer, { ...input, id: randomUUID(), skuId: foreignSku }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        service.save(buyer, {
          ...input,
          id: randomUUID(),
          values: { packSize: 12 },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await service.list(buyer)).items[0]?.history).toHaveLength(1);
      expect(
        (await createAuditLog(database).list(tenantId, supplierId)).filter(
          (e) => e.eventType === 'supplier_terms.recorded',
        ),
      ).toHaveLength(1);
      await database.transaction(tenantId, async (tx) => {
        expect(
          (
            await tx.query(
              'SELECT id FROM procurement_supplier_terms WHERE tenant_id=$1',
              [otherTenant],
            )
          ).rows,
        ).toEqual([]);
        await expect(
          tx.query(
            'UPDATE procurement_supplier_terms SET revision=2 WHERE tenant_id=$1',
            [tenantId],
          ),
        ).rejects.toThrow(/permission denied/);
      });
    } finally {
      await runtime?.end();
      await db.drop();
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  }, 60_000);
});
