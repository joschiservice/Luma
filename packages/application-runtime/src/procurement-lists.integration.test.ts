import { randomUUID } from 'node:crypto';

import { createAuditLog } from '@luma/audit/composition';
import { PermissionSet } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import {
  createProcurement,
  createSupplierCommitmentService,
} from '@luma/procurement/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase } from './test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  'Procurement lists by custom fields on PostgreSQL',
  () => {
    let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
    let runtime: Pool;
    let procurement: ReturnType<typeof createProcurement>;
    let commitments: ReturnType<typeof createSupplierCommitmentService>;
    let role = '';
    const tenant = randomUUID(),
      otherTenant = randomUUID();
    const at = new Date().toISOString();

    function context(tenantId: string = tenant, permissions?: string[]) {
      const membership = builtInMembership(
        { id: 'membership', organizationId: tenantId, userId: 'operator' },
        'owner',
      );

      return makeTenantContext(
        { userId: 'operator', sessionId: 'session' },
        {
          id: tenantId,
          name: 'Fixture',
          slug: 'fixture',
          status: 'active',
          dataRegion: 'AU',
        },
        permissions
          ? { ...membership, permissions: new PermissionSet(permissions) }
          : membership,
        randomUUID(),
      );
    }

    /** Defines a custom field directly, as the adaptive area stores it. */
    async function field(
      recordType: 'purchase_order' | 'supplier',
      type: string,
      options: { readPermission?: string; archived?: boolean } = {},
    ) {
      const id = randomUUID();
      const key = `f_${id.replaceAll('-', '')}`;
      const archived = options.archived ?? false;
      await database.owner.query(
        'INSERT INTO adaptive_fields(tenant_id,id,record_type,field_key,field_type,archived,source,document,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          tenant,
          id,
          recordType,
          key,
          type,
          archived,
          'luma',
          {
            id,
            recordType,
            key,
            type,
            label: { en: 'Field', de: 'Feld' },
            choices: [],
            readPermission: options.readPermission ?? 'procurement.read',
            writePermission: 'procurement.manage',
            revision: 1,
            archived,
            source: 'luma',
            createdAt: at,
            updatedAt: at,
          },
          at,
        ],
      );

      return id;
    }

    async function value(
      recordType: 'purchase_order' | 'supplier',
      recordId: string,
      fieldId: string,
      stored: unknown,
    ) {
      await database.owner.query(
        'INSERT INTO adaptive_field_values(tenant_id,record_type,record_id,field_id,value,document) VALUES($1,$2,$3,$4,$5,$6)',
        [
          tenant,
          recordType,
          recordId,
          fieldId,
          JSON.stringify(stored),
          { fieldId, value: stored },
        ],
      );
    }

    beforeAll(async () => {
      database = await createMigratedDatabase(databaseUrl!);
      const { owner } = database;
      const url = new URL(databaseUrl!);
      const { name } = (
        await owner.query<{ name: string }>('SELECT current_database() AS name')
      ).rows[0]!;
      url.pathname = `/${name}`;
      url.password = randomUUID();
      role = `procurement_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      url.username = role;
      // The runtime login mirrors the API's: procurement, audit and custom field reads.
      await owner.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${url.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      await owner.query(
        `GRANT luma_desk,luma_audit,luma_adaptive TO "${role}"`,
      );
      for (const id of [tenant, otherTenant])
        await owner.query(
          "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Fixture',$2,'active',now())",
          [id, `procurement-${id}`],
        );
      runtime = new Pool({ connectionString: url.toString() });
      const db = createTenantDatabase(runtime);
      procurement = createProcurement(db, async (c) => c, createAuditLog);
      commitments = createSupplierCommitmentService(db, createAuditLog, {
        purchasing: null,
        admission: null,
        refreshContext: async (c) => c,
        principal: async () => context(),
        openOrder: async () => {},
        trace: () => ({
          traceId: randomUUID(),
          spanId: randomUUID(),
          requestId: randomUUID(),
        }),
        model: { gateway: null, available: false, reason: 'Not needed' },
      });
    }, 120_000);

    afterAll(async () => {
      await runtime?.end();
      await database?.drop();
      if (role) {
        const admin = new Pool({ connectionString: databaseUrl });
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        await admin.end();
      }
    });

    it('filters and sorts purchase orders by readable custom fields in SQL before paging', async () => {
      const owner = context();
      const supplier = await procurement.createSupplier(owner, {
        id: randomUUID(),
        name: 'Acme Bags',
      });
      const order = (reference: string) =>
        procurement.createOrder(owner, {
          id: randomUUID(),
          supplierId: supplier.id,
          reference,
          lines: [
            {
              id: randomUUID(),
              sku: `${reference}-SKU`,
              description: 'Tote',
              quantity: 1,
              unit: 'each',
            },
          ],
        });
      const [a, b] = [await order('PO-A'), await order('PO-B')];
      await order('PO-C');
      const priority = await field('purchase_order', 'number');
      const approved = await field('purchase_order', 'boolean');
      const due = await field('purchase_order', 'date');
      const labels = await field('purchase_order', 'multi_choice');
      const note = await field('purchase_order', 'text');
      const buyer = await field('purchase_order', 'person');
      // No role grants this permission, so even an owner cannot read the field.
      const secret = await field('purchase_order', 'text', {
        readPermission: 'restricted.fields.read',
      });
      const retired = await field('purchase_order', 'number', {
        archived: true,
      });
      // A supplier field never applies to purchase orders.
      const supplierField = await field('supplier', 'number');
      await value('purchase_order', a.id, priority, 3);
      await value('purchase_order', b.id, priority, 1);
      await value('purchase_order', a.id, approved, true);
      await value('purchase_order', b.id, approved, false);
      await value('purchase_order', a.id, due, '2026-05-01');
      await value('purchase_order', a.id, labels, ['urgent', 'eu']);
      await value('purchase_order', b.id, labels, ['eu']);
      await value('purchase_order', a.id, note, 'Call before delivery');
      await value('purchase_order', b.id, buyer, 'operator');

      type Query = Parameters<typeof commitments.listOrders>[1];

      type Condition = NonNullable<Query['where']>['conditions'][number];

      const list = (query: Partial<Query>, actor = owner) =>
        commitments.listOrders(actor, {
          q: '',
          sort: 'reference',
          direction: 'asc',
          limit: 50,
          ...query,
        });
      const refs = async (query: Partial<Query>) =>
        (await list(query)).items.map((item) => item.reference);
      const all = (...conditions: Condition[]): Partial<Query> => ({
        where: { match: 'all', conditions },
      });
      const custom = (id: string) => `custom:${id}` as const;

      expect(
        await refs(all({ field: custom(priority), op: 'gte', value: 2 })),
      ).toEqual(['PO-A']);
      // An order without a value is empty, never a match for a value or a negative comparison.
      expect(await refs(all({ field: custom(priority), op: 'empty' }))).toEqual(
        ['PO-C'],
      );
      expect(
        await refs(all({ field: custom(priority), op: 'ne', value: 3 })),
      ).toEqual(['PO-B']);
      expect(
        await refs(
          all({
            field: custom(priority),
            op: 'between',
            value: { from: 1, to: 2 },
          }),
        ),
      ).toEqual(['PO-B']);
      expect(
        await refs(all({ field: custom(approved), op: 'is', value: false })),
      ).toEqual(['PO-B']);
      expect(
        await refs(
          all({ field: custom(due), op: 'before', value: '2026-06-01' }),
        ),
      ).toEqual(['PO-A']);
      expect(
        await refs(
          all({ field: custom(labels), op: 'all_of', value: ['urgent', 'eu'] }),
        ),
      ).toEqual(['PO-A']);
      expect(
        await refs(
          all({ field: custom(labels), op: 'none_of', value: ['urgent'] }),
        ),
      ).toEqual(['PO-B', 'PO-C']);
      expect(
        await refs(all({ field: custom(note), op: 'contains', value: 'call' })),
      ).toEqual(['PO-A']);
      expect(
        await refs(
          all({
            field: custom(buyer),
            op: 'any_of',
            value: [{ dynamic: 'me' }],
          }),
        ),
      ).toEqual(['PO-B']);
      // Custom conditions combine with stored and derived conditions.
      expect(
        await refs({
          where: {
            match: 'any',
            conditions: [
              { field: 'reference', op: 'is', value: 'PO-C' },
              { field: custom(priority), op: 'gte', value: 3 },
            ],
          },
        }),
      ).toEqual(['PO-A', 'PO-C']);
      expect(
        await refs(
          all(
            { field: custom(priority), op: 'not_empty' },
            { field: 'stage', op: 'any_of', value: ['draft'] },
          ),
        ),
      ).toEqual(['PO-A', 'PO-B']);
      expect(
        (
          await list({
            ...all({ field: custom(priority), op: 'not_empty' }),
            count: 'exact',
            limit: 1,
          })
        ).totalCount,
      ).toBe(2);

      // Orders without a value sort last in both directions; cursors keep the sort.
      expect(await refs({ sort: custom(priority), direction: 'asc' })).toEqual([
        'PO-B',
        'PO-A',
        'PO-C',
      ]);
      const pages: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({
          sort: custom(priority),
          direction: 'desc',
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        pages.push(...page.items.map((item) => item.reference));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(pages).toEqual(['PO-A', 'PO-B', 'PO-C']);

      // The other workspace has no such field.
      await expect(
        list(
          all({ field: custom(priority), op: 'empty' }),
          context(otherTenant),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      // Members can't filter or sort by a field they may not read.
      await expect(
        list(all({ field: custom(secret), op: 'is', value: 'x' })),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(list({ sort: custom(secret) })).rejects.toMatchObject({
        statusCode: 403,
      });
      // A reader with only the field's read permission may use it.
      expect(
        (
          await list(
            all({ field: custom(priority), op: 'empty' }),
            context(tenant, ['procurement.read']),
          )
        ).items.map((item) => item.reference),
      ).toEqual(['PO-C']);
      // Archived, foreign and unknown fields need repair.
      for (const id of [retired, supplierField, randomUUID()])
        await expect(
          list(all({ field: custom(id), op: 'empty' })),
        ).rejects.toMatchObject({ statusCode: 400 });
      await expect(list({ sort: custom(retired) })).rejects.toMatchObject({
        statusCode: 400,
      });
      // Fields with several values can't order the list, and operators follow the field type.
      await expect(list({ sort: custom(labels) })).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(
        list(all({ field: custom(priority), op: 'contains', value: '3' })),
      ).rejects.toMatchObject({ statusCode: 400 });
    }, 60_000);

    it('filters and sorts suppliers by readable custom fields in SQL', async () => {
      const owner = context();
      const supplier = (name: string) =>
        procurement.createSupplier(owner, { id: randomUUID(), name });
      const [acme, birch] = [
        await supplier('Supplier Acme'),
        await supplier('Supplier Birch'),
      ];
      await supplier('Supplier Cobalt');
      const rating = await field('supplier', 'number');
      const secret = await field('supplier', 'text', {
        readPermission: 'restricted.fields.read',
      });
      await value('supplier', acme.id, rating, 4);
      await value('supplier', birch.id, rating, 2);

      type Query = Parameters<typeof procurement.listSuppliers>[1];

      const list = (query: Partial<Query>) =>
        procurement.listSuppliers(owner, {
          q: 'Supplier',
          sort: 'name',
          limit: 50,
          ...query,
        });
      const names = async (query: Partial<Query>) =>
        (await list(query)).items.map((item) => item.name);

      expect(
        await names({
          where: {
            match: 'all',
            conditions: [{ field: `custom:${rating}`, op: 'gte', value: 3 }],
          },
        }),
      ).toEqual(['Supplier Acme']);
      expect(
        await names({
          where: {
            match: 'all',
            conditions: [{ field: `custom:${rating}`, op: 'empty' }],
          },
        }),
      ).toEqual(['Supplier Cobalt']);
      expect(
        await names({ sort: `custom:${rating}`, direction: 'asc' }),
      ).toEqual(['Supplier Birch', 'Supplier Acme', 'Supplier Cobalt']);
      const pages: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({
          sort: `custom:${rating}`,
          direction: 'desc',
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        pages.push(...page.items.map((item) => item.name));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(pages).toEqual([
        'Supplier Acme',
        'Supplier Birch',
        'Supplier Cobalt',
      ]);
      await expect(
        list({
          where: {
            match: 'all',
            conditions: [{ field: `custom:${secret}`, op: 'empty' }],
          },
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(list({ sort: `custom:${secret}` })).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(
        list({ sort: `custom:${randomUUID()}` }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }, 60_000);

    it('reads a supplier with only its orders and its 20 newest messages', async () => {
      const owner = context();
      const supplier = (name: string) =>
        procurement.createSupplier(owner, { id: randomUUID(), name });
      const [mine, theirs] = [
        await supplier('Detail Mine'),
        await supplier('Detail Theirs'),
      ];
      const order = (supplierId: string, reference: string) =>
        procurement.createOrder(owner, {
          id: randomUUID(),
          supplierId,
          reference,
          lines: [
            {
              id: randomUUID(),
              sku: `${reference}-SKU`,
              description: 'Tote',
              quantity: 1,
              unit: 'each',
            },
          ],
        });
      const first = await order(mine.id, 'PO-DETAIL-1');
      await order(theirs.id, 'PO-DETAIL-OTHER');
      const second = await order(mine.id, 'PO-DETAIL-2');
      const base = Date.parse('2026-10-01T00:00:00Z');
      const received = (index: number) =>
        new Date(base + index * 60_000).toISOString();
      for (const [supplierId, count] of [
        [mine.id, 25],
        [theirs.id, 3],
      ] as const)
        for (let index = 0; index < count; index++) {
          const id = randomUUID();
          await database.owner.query(
            'INSERT INTO procurement_communications(tenant_id,id,supplier_id,purchase_order_id,message_key,document,received_at,retain_until,created_at) VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$6)',
            [
              tenant,
              id,
              supplierId,
              id,
              {
                id,
                tenantId: tenant,
                supplierId,
                purchaseOrderId: null,
                channel: 'email',
                from: 'supplier@example.com',
                subject: `Message ${index}`,
                body: 'Text',
                receivedAt: received(index),
                messageId: null,
                digest: id,
                capturedBy: 'operator',
                capturedAt: received(index),
                retainUntil: '2027-10-01T00:00:00Z',
              },
              received(index),
              '2027-10-01T00:00:00Z',
            ],
          );
        }

      const detail = await commitments.supplier(owner, mine.id);

      expect(detail.orders.map((row) => row.order.id)).toEqual([
        second.id,
        first.id,
      ]);
      expect(detail.communications).toHaveLength(20);
      expect(detail.communications.map((c) => c.subject)).toEqual(
        Array.from({ length: 20 }, (_, index) => `Message ${24 - index}`),
      );
      expect(detail.communications.every((c) => c.supplierId === mine.id)).toBe(
        true,
      );
      await expect(
        commitments.supplier(context(otherTenant), mine.id),
      ).rejects.toMatchObject({ statusCode: 404 });
    }, 60_000);
  },
);
