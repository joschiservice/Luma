import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

import { createAdaptiveFields } from '@luma/adaptive/composition';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createMigratedDatabase } from '../test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('adaptive custom fields on PostgreSQL', () => {
  it('enforces RLS, atomic value revisions and immutable history and measures a 100,000-order indexed list', async () => {
    const db = await createMigratedDatabase(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    const role = `adaptive_${randomUUID().replaceAll('-', '')}`;
    let runtime: Pool | undefined;
    try {
      const password = randomUUID();
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await admin.query(`GRANT luma_adaptive TO "${role}"`);
      const url = new URL(db.owner.options.connectionString!);
      url.username = role;
      url.password = password;
      runtime = new Pool({ connectionString: url.toString() });
      const database = createTenantDatabase(runtime);
      const tenantId = randomUUID(),
        foreignTenant = randomUUID(),
        actorId = randomUUID(),
        foreignRecord = randomUUID();
      for (const tenant of [tenantId, foreignTenant])
        await db.owner.query(
          "INSERT INTO organizations(data_region,id,name,slug,created_at) VALUES('AU',$1::uuid,'Shop',$1::text,now())",
          [tenant],
        );
      const context = (tenant: string) =>
        makeTenantContext(
          { userId: actorId, sessionId: randomUUID() },
          {
            id: tenant,
            name: 'Shop',
            slug: tenant,
            dataRegion: 'AU',
            status: 'active',
          },
          builtInMembership(
            { id: randomUUID(), organizationId: tenant, userId: actorId },
            'owner',
          ),
          randomUUID(),
        );
      const buyer = context(tenantId);
      await db.owner.query(
        "INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key) SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,$1,'order',i::text FROM generate_series(1,100000) i",
        [tenantId],
      );
      await db.owner.query(
        "INSERT INTO orders_entities(id,tenant_id,kind,reconciliation_key) VALUES($1,$2,'order','foreign')",
        [foreignRecord, foreignTenant],
      );
      const fields = createAdaptiveFields(database, {
        refreshContext: async (c) => c,
        released: async () => true,
      });
      const definition = {
        recordType: 'order' as const,
        key: 'priority_score',
        label: { en: 'Priority score', de: 'Prioritätswert' },
        type: 'number' as const,
        choices: [],
        readPermission: 'adaptive.fields.read',
        writePermission: 'adaptive.fields.write',
        commandId: randomUUID(),
      };
      const field = await fields.create(buyer, definition);
      expect(await fields.create(buyer, definition)).toEqual(field);
      expect(await fields.list(context(foreignTenant), 'order')).toEqual([]);
      await db.owner.query(
        `INSERT INTO adaptive_field_values(tenant_id,record_type,record_id,field_id,value,document) SELECT $1,'order',('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,$2::uuid,to_jsonb(i%100),jsonb_build_object('fieldId',$2::text,'value',i%100,'revision',1,'updatedAt','2026-10-13T00:00:00.000Z','updatedBy',$3::text) FROM generate_series(1,100000) i`,
        [tenantId, field.id, actorId],
      );
      await db.owner.query('ANALYZE adaptive_field_values');
      await db.owner.query('ANALYZE orders_entities');
      const recordId = '00000000-0000-4000-8000-000000000001';
      await fields.writeValues(buyer, 'order', recordId, [
        { fieldId: field.id, value: 9, revision: 1 },
      ]);
      expect(await fields.history(buyer, field.id, recordId)).toHaveLength(1);
      await expect(
        fields.writeValues(buyer, 'order', recordId, [
          { fieldId: field.id, value: 10, revision: 1 },
        ]),
      ).rejects.toMatchObject({ statusCode: 409 });
      const updateInput = {
        recordType: definition.recordType,
        key: definition.key,
        label: definition.label,
        type: definition.type,
        choices: definition.choices,
        readPermission: definition.readPermission,
        writePermission: definition.writePermission,
      };
      await expect(
        fields.update(buyer, field.id, {
          ...updateInput,
          type: 'text',
          revision: 1,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const otherField = await fields.create(buyer, {
        ...definition,
        key: 'approved',
        type: 'boolean',
        commandId: randomUUID(),
      });
      await expect(
        fields.writeValues(buyer, 'order', recordId, [
          { fieldId: field.id, value: 10, revision: 2 },
          { fieldId: otherField.id, value: 'invalid boolean', revision: 0 },
        ]),
      ).rejects.toMatchObject({ statusCode: 422 });
      expect(
        (await fields.readValues(buyer, 'order', recordId)).values.find(
          (v) => v.fieldId === field.id,
        ),
      ).toMatchObject({ value: 9, revision: 2 });
      await expect(
        fields.readValues(buyer, 'order', foreignRecord),
      ).rejects.toMatchObject({ statusCode: 404 });
      await database.transaction(tenantId, async (tx) => {
        expect(
          (
            await tx.query(
              'SELECT id FROM adaptive_fields WHERE tenant_id=$1',
              [foreignTenant],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await tx.query(
              'SELECT field_id FROM adaptive_field_values WHERE tenant_id=$1',
              [foreignTenant],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await tx.query(
              'SELECT id FROM adaptive_field_events WHERE tenant_id=$1',
              [foreignTenant],
            )
          ).rows,
        ).toEqual([]);
      });
      await expect(
        database.transaction(tenantId, (tx) =>
          tx.query('DELETE FROM adaptive_field_events WHERE tenant_id=$1', [
            tenantId,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        database.transaction(tenantId, (tx) =>
          tx.query(
            `INSERT INTO adaptive_fields(tenant_id,id,record_type,field_key,field_type,archived,source,document,created_at) SELECT $1,id,'order','other','number',false,'luma',document,created_at FROM adaptive_fields WHERE tenant_id=$2`,
            [foreignTenant, tenantId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      const times: number[] = [];
      let result = await fields.query(buyer, {
        recordType: 'order',
        filters: [{ fieldId: field.id, operator: 'eq', value: 9 }],
        limit: 50,
      });
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        result = await fields.query(buyer, {
          recordType: 'order',
          filters: [{ fieldId: field.id, operator: 'eq', value: 9 }],
          limit: 50,
        });
        times.push(performance.now() - start);
      }
      expect(result.recordIds).toHaveLength(50);
      expect(result.hasMore).toBe(true);
      const payloadBytes = Buffer.byteLength(JSON.stringify(result));
      expect(payloadBytes).toBeLessThan(128 * 1024);
      const grouped = await fields.query(buyer, {
        recordType: 'order',
        filters: [{ fieldId: field.id, operator: 'gte', value: 99 }],
        sort: { fieldId: field.id, direction: 'desc' },
        groupBy: field.id,
        limit: 50,
      });
      expect(grouped.groups).toEqual([{ value: 99, count: 1000 }]);
      const plan = await database.transaction(tenantId, (tx) =>
        tx.query(
          `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT r.id FROM orders_entities r WHERE r.tenant_id=$1 AND r.kind='order' AND EXISTS(SELECT 1 FROM adaptive_field_values v WHERE v.tenant_id=$1 AND v.record_type='order' AND v.field_id=$2 AND v.record_id=r.id AND v.number_value=$3) ORDER BY r.id LIMIT 51`,
          [tenantId, field.id, 9],
        ),
      );
      const report = {
        scenario: '100000-order-custom-field-filter',
        records: 100000,
        role: 'luma_adaptive',
        forcedRls: true,
        samplesMs: times,
        p95Ms: [...times].sort((a, b) => a - b)[9],
        payloadBytes,
        payloadBudgetBytes: 128 * 1024,
        plan: plan.rows,
      };
      const directory = new URL(
        '../../../../.luma/performance/',
        import.meta.url,
      );
      await mkdir(directory, { recursive: true });
      await writeFile(
        new URL('adaptive-fields-100k.json', directory),
        JSON.stringify(report, null, 2) + '\n',
      );
    } finally {
      await runtime?.end();
      await db.drop();
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  }, 60000);
});
