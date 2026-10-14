import { randomUUID } from 'node:crypto';

import { createCommerceServices } from '@luma/application-runtime';
import type { CommerceObservation } from '@luma/connections';
import { PermissionSet } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import {
  createInventoryWorkspace,
  createProductWorkspace,
} from '@luma/read-models/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase } from './test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

type ProductData = Extract<
  CommerceObservation,
  { capability: 'products.read' }
>['observation']['data'];

type StockData = Extract<
  CommerceObservation,
  { capability: 'inventory.read' }
>['observation']['data'];

describe.skipIf(!databaseUrl)(
  'Products and inventory lists on PostgreSQL',
  () => {
    let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
    let reader: Pool, services: ReturnType<typeof createCommerceServices>;
    const roles: string[] = [];
    const tenant = randomUUID(),
      otherTenant = randomUUID(),
      shopify = randomUUID(),
      jtl = randomUUID(),
      foreign = randomUUID();
    const now = Date.now();
    const recent = new Date(now - 60_000).toISOString();
    const old = new Date(now - 3 * 3_600_000).toISOString();
    const ids: Record<string, string> = {};

    function context(
      tenantId: string = tenant,
      permissions?: string[],
    ): ReturnType<typeof makeTenantContext> {
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

    const provider = (connectionId: string) =>
      connectionId === jtl ? 'jtl' : 'shopify';

    /** Ingests one product and binds it and its SKUs by explicit keys. */
    async function product(options: {
      tenantId?: string;
      connectionId: string;
      external: string;
      data: Omit<ProductData, 'skus'>;
      skus: (Omit<ProductData['skus'][number], 'id' | 'unit'> & {
        external: string;
        key: string;
      })[];
    }) {
      const tenantId = options.tenantId ?? tenant;
      const source = {
        tenantId,
        connectionId: options.connectionId,
        provider: provider(options.connectionId),
        resource: 'product' as const,
        externalId: options.external,
        scopeKey: '',
      };
      const id = randomUUID();
      const actor = context(tenantId);
      await services.ingestion.ingest(actor, id, {
        capability: 'products.read',
        observation: {
          id,
          source,
          kind: 'snapshot',
          observedAt: recent,
          sourceUpdatedAt: recent,
          sourceRevision: null,
          adapterVersion: 'fixture/1',
          schemaVersion: 1,
          data: {
            ...options.data,
            skus: options.skus.map((sku) => ({
              id: { externalId: sku.external, scopeKey: '' },
              code: sku.code,
              unit: 'each',
              ...(sku.price ? { price: sku.price } : {}),
              ...(sku.barcode ? { barcode: sku.barcode } : {}),
              ...(sku.bundle ? { bundle: sku.bundle } : {}),
            })),
          },
        },
      });
      await services.ingestion.bind(
        actor,
        source,
        `product:${options.connectionId}:${options.external}`,
        id,
        'operator-confirmed',
      );
      for (const sku of options.skus) {
        const skuId = await services.ingestion.bind(
          actor,
          { ...source, resource: 'sku', externalId: sku.external },
          sku.key,
          id,
          'operator-confirmed',
        );
        if (tenantId === tenant) ids[sku.key] = skuId;
      }
      await services.ingestion.replay(actor, options.connectionId, id);
    }

    /** Ingests one stock position report and binds its SKU and location by explicit keys. */
    async function stock(options: {
      tenantId?: string;
      connectionId: string;
      external: string;
      sku: string;
      location: string;
      observedAt?: string;
      data: Omit<StockData, 'sku' | 'location' | 'unit'>;
    }) {
      const tenantId = options.tenantId ?? tenant;
      // One record per SKU and location, as adapters scope stock reads by location.
      const source = {
        tenantId,
        connectionId: options.connectionId,
        provider: provider(options.connectionId),
        resource: 'sku' as const,
        externalId: options.external,
        scopeKey: options.location,
      };
      const id = randomUUID();
      const actor = context(tenantId);
      await services.ingestion.ingest(actor, id, {
        capability: 'inventory.read',
        observation: {
          id,
          source,
          kind: 'snapshot',
          observedAt: options.observedAt ?? recent,
          sourceUpdatedAt: options.observedAt ?? recent,
          sourceRevision: null,
          adapterVersion: 'fixture/1',
          schemaVersion: 1,
          data: {
            ...options.data,
            sku: { externalId: options.external, scopeKey: '' },
            location: { externalId: options.location, scopeKey: '' },
            unit: 'each',
          },
        },
      });
      await services.ingestion.bind(
        actor,
        source,
        `${options.sku}@${options.location}`,
        id,
        'operator-confirmed',
      );
      const skuId = await services.ingestion.bind(
        actor,
        { ...source, scopeKey: '' },
        options.sku,
        id,
        'operator-confirmed',
      );
      const locationId = await services.ingestion.bind(
        actor,
        {
          ...source,
          resource: 'location',
          externalId: options.location,
          scopeKey: '',
        },
        options.location,
        id,
        'operator-confirmed',
      );
      if (tenantId === tenant) {
        ids[options.sku] = skuId;
        ids[options.location] = locationId;
      }
      await services.ingestion.replay(actor, options.connectionId, id);
    }

    beforeAll(async () => {
      database = await createMigratedDatabase(databaseUrl!);
      const { owner } = database;
      const url = new URL(databaseUrl!);
      const { name } = (
        await owner.query<{ name: string }>('SELECT current_database() AS name')
      ).rows[0]!;
      url.pathname = `/${name}`;
      const password = randomUUID();
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      // The writer mirrors the ingestion worker; the reader mirrors the API login.
      for (const [role, grants] of [
        [`catalog_w_${suffix}`, 'luma_connectors,luma_orders,luma_inventory'],
        [
          `catalog_r_${suffix}`,
          'luma_connectors,luma_case_reader,luma_desk,luma_adaptive,luma_commerce_sync',
        ],
      ] as const) {
        await owner.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
        );
        await owner.query(`GRANT ${grants} TO "${role}"`);
        roles.push(role);
      }
      url.password = password;
      url.username = roles[0]!;
      services = createCommerceServices(url.toString());
      url.username = roles[1]!;
      reader = new Pool({ connectionString: url.toString() });
      for (const [tenantId, id, kind, label] of [
        [tenant, shopify, 'shopify', 'Shopify store'],
        [tenant, jtl, 'jtl', 'JTL-Wawi'],
        [otherTenant, foreign, 'shopify', 'Other store'],
      ] as const) {
        await owner.query(
          "INSERT INTO workspace_apps(tenant_id,app_id,status,version) VALUES($1,$2,'installed',1) ON CONFLICT DO NOTHING",
          [tenantId, kind],
        );
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
              appId: kind,
              appInstallationVersion: 1,
              target: { kind },
              label,
              permissions: ['products.read', 'inventory.read'],
              granted: ['products.read', 'inventory.read'],
            },
            'encrypted-fixture',
          ],
        );
      }

      // SKU-A: both sources, titles and publication differ; JTL reports a price without currency.
      await product({
        connectionId: shopify,
        external: 'gid://shopify/Product/1',
        data: {
          title: 'Canvas tote',
          status: 'active',
          vendor: 'Luma Goods',
          published: true,
        },
        skus: [
          {
            external: 'A',
            key: 'SKU-A',
            code: 'SKU-A',
            price: { amount: '24.00', currency: 'EUR' },
            barcode: '0012345678905',
          },
        ],
      });
      await product({
        connectionId: jtl,
        external: '1',
        data: {
          title: 'Canvas tote bag',
          status: 'active',
          vendor: 'Luma Goods',
          published: false,
        },
        skus: [
          {
            external: '1',
            key: 'SKU-A',
            code: 'SKU-A',
            price: { amount: '26.00', currency: null },
            barcode: '012345678905',
          },
        ],
      });
      // SKU-B: a Shopify draft without a barcode, missing from JTL.
      await product({
        connectionId: shopify,
        external: 'gid://shopify/Product/2',
        data: {
          title: 'Linen apron',
          status: 'draft',
          vendor: 'Weaver',
          published: false,
        },
        skus: [
          {
            external: 'B',
            key: 'SKU-B',
            code: 'SKU-B',
            price: { amount: '18.00', currency: 'EUR' },
          },
        ],
      });
      // SKU-C: an archived JTL bundle without vendor or price, missing from Shopify.
      await product({
        connectionId: jtl,
        external: '3',
        data: { title: 'Gift set', status: 'archived', vendor: null },
        skus: [
          {
            external: '3',
            key: 'SKU-C',
            code: 'SKU-C',
            bundle: {
              variant: { externalId: '3', scopeKey: '' },
              requiresComponents: true,
              components: null,
            },
          },
        ],
      });
      await product({
        tenantId: otherTenant,
        connectionId: foreign,
        external: 'gid://shopify/Product/9',
        data: { title: 'Foreign', status: 'draft', vendor: 'Weaver' },
        skus: [{ external: 'F', key: 'SKU-F', code: 'SKU-F' }],
      });

      // Position X: SKU-A in Tokyo from both sources; JTL is below its safety stock.
      await stock({
        connectionId: shopify,
        external: 'A',
        sku: 'SKU-A',
        location: 'Tokyo',
        data: {
          onHand: '12',
          reserved: null,
          available: '12',
          incoming: '0',
          safetyStock: '5',
          tracked: true,
          itemActive: true,
          locationActive: true,
          availabilityBasis: 'provider_reported',
        },
      });
      await stock({
        connectionId: jtl,
        external: '1',
        sku: 'SKU-A',
        location: 'Tokyo',
        data: {
          onHand: '11',
          reserved: '2',
          available: '9',
          incoming: '4',
          safetyStock: '10',
          availabilityBasis: 'derived',
        },
      });
      // Position Y: SKU-A in Osaka, Shopify only, untracked with nothing available.
      await stock({
        connectionId: shopify,
        external: 'A',
        sku: 'SKU-A',
        location: 'Osaka',
        data: {
          onHand: '0',
          reserved: null,
          available: '0',
          tracked: false,
          availabilityBasis: 'provider_reported',
        },
      });
      // Position Z: SKU-B in Tokyo, JTL only, oversold with unknown on-hand, read hours ago.
      await stock({
        connectionId: jtl,
        external: '2',
        sku: 'SKU-B',
        location: 'Tokyo',
        observedAt: old,
        data: {
          onHand: null,
          reserved: null,
          available: '-2',
          availabilityBasis: 'unknown',
        },
      });
      await stock({
        tenantId: otherTenant,
        connectionId: foreign,
        external: 'F',
        sku: 'SKU-F',
        location: 'Tokyo',
        data: {
          onHand: '1',
          reserved: '0',
          available: '1',
          availabilityBasis: 'provider_reported',
        },
      });
    }, 120_000);

    afterAll(async () => {
      await services?.close();
      await reader?.end();
      await database?.drop();
      const admin = new Pool({ connectionString: databaseUrl });
      for (const role of roles)
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    });

    it('filters products by listing facts in every source scope, groups them and pages inside a group', async () => {
      const products = createProductWorkspace(createTenantDatabase(reader));

      type Query = Parameters<typeof products.list>[1];

      type Condition = NonNullable<Query['where']>['conditions'][number];

      const list = (query: Partial<Query> = {}, actor = context()) =>
        products.list(actor, { q: '', view: 'all', ...query });
      const skus = async (
        conditions: Condition[],
        options: Partial<Query> = {},
        match: 'all' | 'any' = 'all',
      ) =>
        (await list({ ...options, where: { match, conditions } })).items.map(
          (item) => item.sku,
        );

      expect(await skus([])).toEqual(['SKU-A', 'SKU-B', 'SKU-C']);
      expect(
        await skus([{ field: 'status', op: 'any_of', value: ['draft'] }]),
      ).toEqual(['SKU-B']);
      expect(
        await skus([{ field: 'status', op: 'none_of', value: ['active'] }]),
      ).toEqual(['SKU-B', 'SKU-C']);
      expect(
        await skus([
          {
            field: 'status',
            op: 'any_of',
            value: ['active'],
            source: 'every',
          },
        ]),
      ).toEqual(['SKU-A']);
      // Published: any source, every source, one named source.
      expect(
        await skus([{ field: 'published', op: 'is', value: false }]),
      ).toEqual(['SKU-A', 'SKU-B']);
      expect(
        await skus([
          { field: 'published', op: 'is', value: true, source: 'every' },
        ]),
      ).toEqual([]);
      expect(
        await skus([
          { field: 'published', op: 'is', value: false, source: jtl },
        ]),
      ).toEqual(['SKU-A']);
      // Unreported publication never matches either value.
      expect(
        await skus([
          { field: 'published', op: 'is', value: true, source: jtl },
        ]),
      ).toEqual([]);
      expect(
        await skus([{ field: 'vendor', op: 'contains', value: 'weav' }]),
      ).toEqual(['SKU-B']);
      expect(await skus([{ field: 'vendor', op: 'empty' }])).toEqual(['SKU-C']);
      // Prices compare only within their currency; JTL's price without a currency never matches.
      expect(
        await skus([
          {
            field: 'price',
            op: 'gte',
            value: { amount: '20', currency: 'EUR' },
          },
        ]),
      ).toEqual(['SKU-A']);
      expect(
        await skus([
          {
            field: 'price',
            op: 'gt',
            value: { amount: '1', currency: 'EUR' },
            source: jtl,
          },
        ]),
      ).toEqual([]);
      expect(
        await skus([
          {
            field: 'price',
            op: 'between',
            value: {
              from: { amount: '10', currency: 'EUR' },
              to: { amount: '20', currency: 'EUR' },
            },
          },
        ]),
      ).toEqual(['SKU-B']);
      expect(await skus([{ field: 'price', op: 'empty' }])).toEqual(['SKU-C']);
      expect(await skus([{ field: 'barcode', op: 'empty' }])).toEqual([
        'SKU-B',
        'SKU-C',
      ]);
      expect(
        await skus([{ field: 'barcode', op: 'empty', source: shopify }]),
      ).toEqual(['SKU-B']);
      expect(await skus([{ field: 'bundle', op: 'is', value: true }])).toEqual([
        'SKU-C',
      ]);
      expect(
        await skus([{ field: 'differences', op: 'all_of', value: ['title'] }]),
      ).toEqual(['SKU-A']);
      expect(await skus([{ field: 'differences', op: 'empty' }])).toEqual([
        'SKU-B',
        'SKU-C',
      ]);
      expect(
        await skus([{ field: 'listings', op: 'none_of', value: [jtl] }]),
      ).toEqual(['SKU-B']);
      expect(
        await skus([{ field: 'missing', op: 'any_of', value: [jtl] }]),
      ).toEqual(['SKU-B']);
      expect(await skus([{ field: 'missing', op: 'not_empty' }])).toEqual([
        'SKU-B',
        'SKU-C',
      ]);
      expect(
        await skus([
          {
            field: 'updated',
            op: 'within_last',
            value: { amount: 1, unit: 'day' },
          },
        ]),
      ).toEqual(['SKU-A', 'SKU-B', 'SKU-C']);
      expect(
        await skus(
          [
            { field: 'bundle', op: 'is', value: true },
            { field: 'status', op: 'any_of', value: ['draft'] },
          ],
          {},
          'any',
        ),
      ).toEqual(['SKU-B', 'SKU-C']);
      // Conditions narrow the built-in view counts too.
      expect(
        (
          await list({
            where: {
              match: 'all',
              conditions: [{ field: 'vendor', op: 'not_empty' }],
            },
          })
        ).counts,
      ).toEqual({ all: 2, differs: 1, missing: 1, unlinked: 0 });
      await expect(
        skus([{ field: 'published', op: 'is', value: true, source: 'lowest' }]),
      ).rejects.toMatchObject({ statusCode: 400 });

      const byStatus = await list({ group: { field: 'status' } });
      expect(
        byStatus.groups?.map((group) => [
          group.key,
          group.count,
          group.itemIds,
        ]),
      ).toEqual([
        ['active', 1, [ids['SKU-A']]],
        ['draft', 1, [ids['SKU-B']]],
        ['archived', 1, [ids['SKU-C']]],
      ]);
      expect(byStatus.groupsTruncated).toBe(false);
      const byVendor = await list({ group: { field: 'vendor' } });
      expect(byVendor.groups?.map((group) => [group.key, group.count])).toEqual(
        [
          ['Luma Goods', 1],
          ['Weaver', 1],
          [null, 1],
        ],
      );
      // A SKU counts once per differing field; SKUs without differences form the last group.
      const byDifference = await list({
        group: { field: 'differences' },
        groupLimit: 1,
      });
      expect(
        byDifference.groups?.map((group) => [group.key, group.count]),
      ).toEqual([
        ['title', 1],
        ['published', 1],
        [null, 2],
      ]);
      const empty = byDifference.groups!.at(-1)!;
      expect(empty.itemIds).toEqual([ids['SKU-B']]);
      const rest = await list({
        group: { field: 'differences' },
        groupKey: null,
        limit: 1,
        cursor: empty.nextCursor!,
      });
      expect(rest.items.map((item) => item.sku)).toEqual(['SKU-C']);
      expect(rest.groups).toEqual([
        expect.objectContaining({ key: null, count: 2, nextCursor: null }),
      ]);
      // Group cursors continue only their own group and query.
      await expect(
        list({
          group: { field: 'differences' },
          groupKey: 'title',
          cursor: empty.nextCursor!,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        list({ group: { field: 'status' }, cursor: empty.nextCursor! }),
      ).rejects.toMatchObject({ statusCode: 400 });

      // Cursors bind the conditions.
      const first = await list({
        limit: 1,
        where: {
          match: 'all',
          conditions: [{ field: 'vendor', op: 'not_empty' }],
        },
      });
      expect(first.items.map((item) => item.sku)).toEqual(['SKU-A']);
      expect(
        (
          await list({
            limit: 1,
            where: {
              conditions: [{ field: 'vendor', op: 'not_empty' }],
              match: 'all',
            },
            cursor: first.nextCursor!,
          })
        ).items.map((item) => item.sku),
      ).toEqual(['SKU-B']);
      await expect(
        list({
          limit: 1,
          where: {
            match: 'all',
            conditions: [{ field: 'vendor', op: 'empty' }],
          },
          cursor: first.nextCursor!,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });

      // Tenants see only their own catalog and groups.
      const foreignList = await list(
        { group: { field: 'vendor' } },
        context(otherTenant),
      );
      expect(foreignList.groups?.map((group) => group.key)).toEqual(['Weaver']);
      expect(foreignList.items.map((item) => item.sku)).toEqual(['SKU-F']);
      await expect(
        list({}, context(tenant, ['inventory.read'])),
      ).rejects.toMatchObject({ statusCode: 403 });
    }, 60_000);

    it('filters and sorts products by custom product fields the reader may read, before paging', async () => {
      const { owner } = database;
      const at = new Date().toISOString();
      await owner.query(
        "INSERT INTO organizations(data_region,id,name,slug,status,created_at) VALUES('AU',$1,'Catalog',$2,'active',now()) ON CONFLICT DO NOTHING",
        [tenant, `catalog-${tenant}`],
      );
      const field = async (
        type: string,
        options: {
          readPermission?: string;
          recordType?: string;
          archived?: boolean;
        } = {},
      ) => {
        const id = randomUUID();
        const key = `f_${id.replaceAll('-', '')}`;
        const recordType = options.recordType ?? 'product';
        const archived = options.archived ?? false;
        await owner.query(
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
              readPermission: options.readPermission ?? 'products.read',
              writePermission: 'products.read',
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
      };
      const value = (sku: string, id: string, stored: unknown) =>
        owner.query(
          'INSERT INTO adaptive_field_values(tenant_id,record_type,record_id,field_id,value,document) VALUES($1,$2,$3,$4,$5,$6)',
          [
            tenant,
            'product',
            ids[sku],
            id,
            JSON.stringify(stored),
            { fieldId: id, value: stored },
          ],
        );
      const rating = await field('number');
      const labels = await field('multi_choice');
      const restocked = await field('date');
      // No role grants this permission, so even an owner cannot read the field.
      const secret = await field('text', {
        readPermission: 'restricted.fields.read',
      });
      const retired = await field('number', { archived: true });
      // A supplier field with the same shape never applies to products.
      const supplierField = await field('number', {
        readPermission: 'procurement.read',
        recordType: 'supplier',
      });
      await value('SKU-A', rating, 5);
      await value('SKU-B', rating, 2);
      await value('SKU-A', labels, ['eco', 'core']);
      await value('SKU-B', labels, ['core']);
      await value('SKU-B', restocked, '2026-03-14');

      const products = createProductWorkspace(createTenantDatabase(reader));

      type Query = Parameters<typeof products.list>[1];

      type Condition = NonNullable<Query['where']>['conditions'][number];

      const list = (query: Partial<Query> = {}, actor = context()) =>
        products.list(actor, { q: '', view: 'all', ...query });
      const skus = async (query: Partial<Query>) =>
        (await list(query)).items.map((item) => item.sku);
      const where = (...conditions: Condition[]): Partial<Query> => ({
        where: { match: 'all', conditions },
      });

      expect(
        await skus(where({ field: `custom:${rating}`, op: 'gte', value: 3 })),
      ).toEqual(['SKU-A']);
      // A SKU without a value is empty, never a match for a value or a negative comparison.
      expect(
        await skus(where({ field: `custom:${rating}`, op: 'empty' })),
      ).toEqual(['SKU-C']);
      expect(
        await skus(where({ field: `custom:${rating}`, op: 'ne', value: 5 })),
      ).toEqual(['SKU-B']);
      expect(
        await skus(
          where({ field: `custom:${labels}`, op: 'all_of', value: ['core'] }),
        ),
      ).toEqual(['SKU-A', 'SKU-B']);
      expect(
        await skus(
          where({ field: `custom:${labels}`, op: 'none_of', value: ['eco'] }),
        ),
      ).toEqual(['SKU-B', 'SKU-C']);
      expect(
        await skus(
          where({
            field: `custom:${restocked}`,
            op: 'before',
            value: '2026-03-15',
          }),
        ),
      ).toEqual(['SKU-B']);
      // Conditions run before paging, so the view counts reflect them.
      const filtered = await list(
        where({ field: `custom:${rating}`, op: 'not_empty' }),
      );
      expect(filtered.counts.all).toBe(2);
      // SKUs without a value sort last in both directions; the cursor keeps the sort.
      expect(
        await skus({ sort: `custom:${rating}`, direction: 'asc' }),
      ).toEqual(['SKU-B', 'SKU-A', 'SKU-C']);
      const first = await list({
        sort: `custom:${rating}`,
        direction: 'desc',
        limit: 2,
      });
      expect(first.items.map((item) => item.sku)).toEqual(['SKU-A', 'SKU-B']);
      expect(
        await skus({
          sort: `custom:${rating}`,
          direction: 'desc',
          limit: 2,
          cursor: first.nextCursor ?? undefined,
        }),
      ).toEqual(['SKU-C']);

      // The other workspace has no such field.
      await expect(
        list(
          where({ field: `custom:${rating}`, op: 'empty' }),
          context(otherTenant),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      // Members can't filter or sort by a field they may not read.
      await expect(
        list(where({ field: `custom:${secret}`, op: 'is', value: 'x' })),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(list({ sort: `custom:${secret}` })).rejects.toMatchObject({
        statusCode: 403,
      });
      // Archived, foreign and unknown fields need repair.
      for (const id of [retired, supplierField, randomUUID()])
        await expect(
          list(where({ field: `custom:${id}`, op: 'empty' })),
        ).rejects.toMatchObject({ statusCode: 400 });
      await expect(list({ sort: `custom:${retired}` })).rejects.toMatchObject({
        statusCode: 400,
      });
      // Fields with several values can't order the list.
      await expect(list({ sort: `custom:${labels}` })).rejects.toMatchObject({
        statusCode: 400,
      });
    }, 60_000);

    it('filters stock positions by source quantities, never treating missing as zero, and groups them', async () => {
      const inventory = createInventoryWorkspace(createTenantDatabase(reader));

      type Query = Parameters<typeof inventory.list>[1];

      type Condition = NonNullable<Query['where']>['conditions'][number];

      const list = (query: Partial<Query> = {}, actor = context()) =>
        inventory.list(actor, { q: '', view: 'all', count: 'exact', ...query });
      const positions = async (
        conditions: Condition[],
        match: 'all' | 'any' = 'all',
      ) =>
        (await list({ where: { match, conditions } })).items.map(
          (item) => `${item.sku}@${item.location}`,
        );
      const x = 'SKU-A@Tokyo',
        y = 'SKU-A@Osaka',
        z = 'SKU-B@Tokyo';

      expect(await positions([])).toEqual([y, x, z]);
      expect(
        await positions([{ field: 'available', op: 'lte', value: 0 }]),
      ).toEqual([y, z]);
      expect(
        await positions([{ field: 'available', op: 'lt', value: 0 }]),
      ).toEqual([z]);
      expect(
        await positions([
          { field: 'available', op: 'eq', value: 0, source: shopify },
        ]),
      ).toEqual([y]);
      expect(
        await positions([
          { field: 'available', op: 'lte', value: 9, source: 'every' },
        ]),
      ).toEqual([y, z]);
      expect(
        await positions([
          { field: 'available', op: 'lte', value: 9, source: 'lowest' },
        ]),
      ).toEqual([y, x, z]);
      expect(
        await positions([
          { field: 'available', op: 'gt', value: 10, source: jtl },
        ]),
      ).toEqual([]);
      // Unknown on-hand is not zero and only matches `empty`.
      expect(
        await positions([{ field: 'onHand', op: 'eq', value: 0 }]),
      ).toEqual([y]);
      expect(await positions([{ field: 'onHand', op: 'empty' }])).toEqual([z]);
      expect(
        await positions([
          { field: 'onHand', op: 'lt', value: 100, source: 'lowest' },
        ]),
      ).toEqual([y, x]);
      expect(
        await positions([{ field: 'incoming', op: 'gt', value: 0 }]),
      ).toEqual([x]);
      expect(
        await positions([{ field: 'belowSafetyStock', op: 'is', value: true }]),
      ).toEqual([x]);
      // Without a safety stock, Osaka is neither below nor above it.
      expect(
        await positions([
          {
            field: 'belowSafetyStock',
            op: 'is',
            value: false,
            source: 'every',
          },
        ]),
      ).toEqual([]);
      expect(
        await positions([{ field: 'tracked', op: 'is', value: false }]),
      ).toEqual([y]);
      expect(
        await positions([
          { field: 'availabilityBasis', op: 'any_of', value: ['derived'] },
        ]),
      ).toEqual([x]);
      expect(
        await positions([
          {
            field: 'lastRead',
            op: 'before',
            value: new Date(now - 3_600_000).toISOString(),
          },
        ]),
      ).toEqual([z]);
      expect(
        await positions([
          { field: 'location', op: 'any_of', value: [ids.Tokyo!] },
        ]),
      ).toEqual([x, z]);
      expect(
        await positions([{ field: 'source', op: 'none_of', value: [jtl] }]),
      ).toEqual([y]);
      expect(
        await positions([
          { field: 'differences', op: 'any_of', value: ['available'] },
        ]),
      ).toEqual([x]);
      expect(
        await positions([{ field: 'sync', op: 'is', value: false }]),
      ).toEqual([y, x, z]);
      expect(
        await positions(
          [
            { field: 'available', op: 'lt', value: 0 },
            { field: 'tracked', op: 'is', value: false },
          ],
          'any',
        ),
      ).toEqual([y, z]);
      await expect(
        positions([
          { field: 'tracked', op: 'is', value: true, source: 'lowest' },
        ]),
      ).rejects.toMatchObject({ statusCode: 400 });

      // Sorting by the lowest reported quantity still pages after conditions.
      const sorted = await list({
        sort: 'available',
        where: {
          match: 'all',
          conditions: [{ field: 'available', op: 'not_empty' }],
        },
        limit: 2,
      });
      expect(
        sorted.items.map((item) => `${item.sku}@${item.location}`),
      ).toEqual([z, y]);
      expect(sorted.totalCount).toBe(3);

      const byLocation = await list({
        group: { field: 'location' },
        groupLimit: 1,
      });
      const tokyo = byLocation.groups!.find(
        (group) => group.key === ids.Tokyo,
      )!;
      expect(tokyo.count).toBe(2);
      expect(
        byLocation.groups!.find((group) => group.key === ids.Osaka)!.count,
      ).toBe(1);
      const inTokyo = await list({
        group: { field: 'location' },
        groupKey: ids.Tokyo!,
        limit: 1,
        cursor: tokyo.nextCursor!,
      });
      expect(
        [...tokyo.itemIds, ...inTokyo.items.map((item) => item.id)].length,
      ).toBe(2);
      expect(inTokyo.groups?.[0]).toMatchObject({ count: 2, nextCursor: null });
      const bySku = await list({ group: { field: 'sku' } });
      expect(
        Object.fromEntries(
          bySku.groups!.map((group) => [group.key, group.count]),
        ),
      ).toEqual({ [ids['SKU-A']!]: 2, [ids['SKU-B']!]: 1 });
      // A position counts in each of its sources' groups.
      const bySource = await list({ group: { field: 'source' } });
      expect(
        Object.fromEntries(
          bySource.groups!.map((group) => [group.key, group.count]),
        ),
      ).toEqual({ [shopify]: 2, [jtl]: 2 });

      const foreignList = await list(
        { group: { field: 'source' } },
        context(otherTenant),
      );
      expect(foreignList.groups?.map((group) => group.key)).toEqual([foreign]);
      await expect(
        list({}, context(tenant, ['products.read'])),
      ).rejects.toMatchObject({ statusCode: 403 });
    }, 60_000);
  },
);
