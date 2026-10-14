import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { viewReaderKeys } from '@luma/adaptive';
import {
  createAdaptiveFields,
  createAdaptiveViewReadAdapter,
  createAdaptiveViews,
  createCollectionStates,
} from '@luma/adaptive/composition';
import { adaptiveViewQueryV1Schema } from '@luma/api-contract';
import type { TenantContext } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('saved views and remembered list state', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const database = `luma_views_test_${suffix}`;
  const login = `luma_views_test_${suffix}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const people = [randomUUID(), randomUUID(), randomUUID()] as const;
  let owner: Pool;
  let runtime: Pool;

  function context(
    tenantId: string,
    userId: string,
    role: 'owner' | 'admin' | 'member' = 'member',
  ): TenantContext {
    return makeTenantContext(
      { userId, sessionId: randomUUID() },
      {
        id: tenantId,
        name: 'Views',
        slug: 'views',
        dataRegion: 'AU',
        status: 'active',
      },
      builtInMembership(
        { id: randomUUID(), organizationId: tenantId, userId },
        role,
      ),
      randomUUID(),
    );
  }

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${database}`;
    owner = new Pool({ connectionString: url.toString() });
    const setup = await admin.connect();
    try {
      await setup.query(
        "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
      );
      await promisify(execFile)(
        process.execPath,
        [new URL('../scripts/migrate.mjs', import.meta.url).pathname],
        { env: { ...process.env, MIGRATION_DATABASE_URL: url.toString() } },
      );
    } finally {
      await setup.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
      setup.release();
    }
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(`GRANT luma_adaptive TO "${login}"`);
    url.username = login;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString() });
    for (const id of [tenant, otherTenant])
      await owner.query(
        "INSERT INTO organizations(id,name,slug,status,data_region,created_at) VALUES($1,'Views',$2,'active','AU',now())",
        [id, `views-${id}`],
      );
    for (const id of people)
      await owner.query(
        "INSERT INTO users(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Person',$2,true,now(),now())",
        [id, `${id}@example.test`],
      );
  }, 60_000);

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.query(`DROP ROLE IF EXISTS "${login}"`);
    await admin.end();
  });

  const states = () =>
    createCollectionStates(createTenantDatabase(runtime), {
      refreshContext: async (value) => value,
    });

  const views = () =>
    createAdaptiveViews(createTenantDatabase(runtime), {
      refreshContext: async (value) => value,
      released: async () => true,
      readers: {
        orders: {
          read: async () => ({ items: [], nextCursor: null, asOf: '' }),
        },
      },
      trace: (value) => ({
        traceId: 'trace',
        spanId: 'span',
        requestId: value.requestId,
      }),
      validateRoles: async () => {},
    });

  const state = (view: string) => ({
    view,
    baseRevision: null,
    draft: null,
    defaultView: null,
    order: [],
    display: {},
  });

  it('keeps the newest save per member and list, isolated by tenant', async () => {
    const service = states();
    const member = context(tenant, people[0]);
    await service.save(member, 'orders', {
      state: state('builtin:overdue'),
      sequence: 2,
    });
    const late = await service.save(member, 'orders', {
      state: state('builtin:all'),
      sequence: 1,
    });
    expect(late.sequence).toBe(2);
    expect(late.state).toMatchObject({ view: 'builtin:overdue' });
    expect(
      (await service.get(context(otherTenant, people[0]), 'orders')).state,
    ).toBeNull();
    expect(
      (await service.get(context(tenant, people[1]), 'orders')).state,
    ).toBeNull();
    const isolated = await createTenantDatabase(runtime).transaction(
      otherTenant,
      (tx) =>
        tx.query(
          'SELECT 1 FROM adaptive_collection_states WHERE tenant_id=$1',
          [tenant],
        ),
    );
    expect(isolated.rowCount).toBe(0);
  });

  it('resets one list or every list for the member only', async () => {
    const service = states();
    const member = context(tenant, people[1]);
    for (const domain of ['orders', 'customers'])
      await service.save(member, domain, {
        state: state('builtin:all'),
        sequence: 1,
      });
    await service.save(context(tenant, people[0]), 'customers', {
      state: state('builtin:all'),
      sequence: 5,
    });
    expect((await service.reset(member, 'orders')).state).toBeNull();
    expect((await service.get(member, 'customers')).state).not.toBeNull();
    expect((await service.resetAll(member)).removed).toBe(1);
    expect(
      (await service.get(context(tenant, people[0]), 'customers')).state,
    ).not.toBeNull();
  });

  it('refuses lists the role cannot read and unknown lists', async () => {
    const service = states();
    const member = context(tenant, people[0]);
    const reader = {
      ...member,
      permissions: new PermissionSet(
        [...member.permissions].filter((key) => key !== 'orders.read'),
      ),
    };
    await expect(service.get(reader, 'orders')).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      service.get(context(tenant, people[0]), 'nowhere'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('removes remembered state with the account', async () => {
    await states().save(context(otherTenant, people[2]), 'orders', {
      state: state('builtin:all'),
      sequence: 1,
    });
    await owner.query('DELETE FROM users WHERE id=$1', [people[2]]);
    const rows = await owner.query(
      'SELECT 1 FROM adaptive_collection_states WHERE user_id=$1',
      [people[2]],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('limits personal views per member and lists only own or shared views', async () => {
    const service = views();
    const member = context(tenant, people[0]);
    const input = (name: string) => ({
      commandId: randomUUID(),
      name,
      description: '',
      sharing: { scope: 'private' as const, roleIds: [] },
      query: adaptiveViewQueryV1Schema.parse({
        version: 1,
        domain: 'orders',
        filters: {},
        columns: ['status'],
      }),
      reviewed: true as const,
    });
    for (let index = 0; index < 50; index += 1)
      await service.create(member, input(`View ${index}`));
    await expect(
      service.create(member, input('One more')),
    ).rejects.toMatchObject({ statusCode: 409 });
    const peer = context(tenant, people[1], 'admin');
    await service.create(peer, input('Peer view'));
    await service.create(peer, {
      ...input('Team view'),
      sharing: { scope: 'workspace', roleIds: [] },
    });
    const listed = (await service.list(member)).items.map((view) => view.name);
    expect(listed).toHaveLength(51);
    expect(listed).toContain('Team view');
    expect(listed).not.toContain('Peer view');
  });

  it('keeps custom field values on customers behind customer read access', async () => {
    const connection = randomUUID();
    const customer = randomUUID();
    await owner.query(
      'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
      [
        tenant,
        connection,
        {
          id: connection,
          tenantId: tenant,
          version: 1,
          status: 'active',
          target: { kind: 'shopify' },
          label: 'Fixture',
          permissions: [],
          granted: [],
        },
        'encrypted-fixture',
      ],
    );
    await owner.query(
      "INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,state,contact_shared,address_shared,observed_at,observation_id) VALUES($1,$2,'c-1',$3,'enabled',false,false,now(),$4)",
      [tenant, connection, customer, randomUUID()],
    );
    const fields = createAdaptiveFields(createTenantDatabase(runtime), {
      refreshContext: async (value) => value,
      released: async () => true,
    });
    const admin = context(tenant, people[1], 'admin');
    const field = await fields.create(admin, {
      commandId: randomUUID(),
      recordType: 'customer',
      key: 'tier',
      label: { en: 'Tier', de: 'Stufe' },
      type: 'text',
      choices: [],
      readPermission: 'adaptive.fields.read',
      writePermission: 'adaptive.fields.write',
    });
    await fields.writeValues(admin, 'customer', customer, [
      { fieldId: field.id, value: 'wholesale', revision: 0 },
    ]);
    expect(
      (await fields.readValues(admin, 'customer', customer)).values,
    ).toMatchObject([{ fieldId: field.id, value: 'wholesale' }]);
    expect(
      (await fields.readMany(admin, 'customer', [customer, randomUUID()]))
        .values,
    ).toMatchObject([
      { recordId: customer, fieldId: field.id, value: 'wholesale' },
    ]);
    const reader = {
      ...admin,
      permissions: new PermissionSet(
        [...admin.permissions].filter((key) => key !== 'customers.read'),
      ),
    };
    await expect(
      fields.readValues(reader, 'customer', customer),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      fields.readValues(
        context(otherTenant, people[1], 'admin'),
        'customer',
        customer,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reads a view and its history stored in format 1 back in format 2', async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    const document = {
      id,
      tenantId: tenant,
      ownerId: people[1],
      name: 'Stored before format 2',
      description: '',
      sharing: { scope: 'private', roleIds: [] },
      revision: 1,
      archived: false,
      createdAt: now,
      updatedAt: now,
      query: {
        version: 1,
        domain: 'orders',
        filters: { view: 'overdue', status: 'open' },
        customFilters: [],
        columns: ['displayNumber', 'dueAt'],
        sort: { field: 'placed', direction: 'asc' },
        groupBy: null,
        layout: 'table',
        metrics: [],
        charts: [],
        actions: [],
      },
    };
    await owner.query(
      'INSERT INTO adaptive_views(tenant_id,id,revision,archived,updated_at,document) VALUES($1,$2,1,false,$3,$4)',
      [tenant, id, now, JSON.stringify(document)],
    );
    await owner.query(
      'INSERT INTO adaptive_view_revisions(tenant_id,view_id,revision,document) VALUES($1,$2,1,$3)',
      [tenant, id, JSON.stringify({ ...document, changedBy: people[1] })],
    );
    const service = views();
    const reader = context(tenant, people[1]);
    const expected = {
      version: 2,
      domain: 'orders',
      state: {
        segment: 'overdue',
        where: {
          match: 'all',
          conditions: [{ field: 'status', op: 'any_of', value: ['open'] }],
        },
        sort: { field: 'placed', direction: 'asc' },
        columns: [{ id: 'number' }, { id: 'due' }],
      },
    };
    const view = await service.get(reader, id);
    expect(view.query).toMatchObject(expected);
    expect((await service.history(reader, id)).items[0]?.query).toMatchObject(
      expected,
    );

    const revised = await service.update(reader, id, {
      commandId: randomUUID(),
      name: view.name,
      description: view.description,
      sharing: view.sharing,
      query: view.query,
      reviewed: true,
      expectedRevision: view.revision,
    });
    const stored = await owner.query<{ document: { query: unknown } }>(
      'SELECT document FROM adaptive_views WHERE tenant_id=$1 AND id=$2',
      [tenant, id],
    );
    expect(revised.revision).toBe(2);
    expect(stored.rows[0]?.document.query).toMatchObject(expected);
  });

  it('runs stored and built-in purchase-order views through the purchase-order list', async () => {
    const supplierId = randomUUID();
    const reads: Record<string, unknown>[] = [];
    const orders = [
      { id: randomUUID(), stage: 'awaiting_confirmation', key: 'a' },
      { id: randomUUID(), stage: 'awaiting_confirmation', key: 'b' },
      { id: randomUUID(), stage: 'confirmed', key: null },
    ].map((order) => ({
      id: order.id,
      reference: `PO-${order.id.slice(0, 4)}`,
      supplierId,
      supplierName: 'Northstar Supply',
      status: 'open',
      stage: order.stage,
      attentionKey:
        order.key && `confirmation_overdue:${order.id}:${order.key}`,
    }));
    const tenantDatabase = createTenantDatabase(runtime);
    const service = createAdaptiveViews(tenantDatabase, {
      refreshContext: async (value) => value,
      released: async () => true,
      readers: {
        procurement: createAdaptiveViewReadAdapter(
          tenantDatabase,
          {
            read: async (_context, filters) => {
              reads.push(filters);

              return {
                items: orders.filter(
                  (order) => !filters.stage || order.stage === filters.stage,
                ),
                nextCursor: null,
                asOf: new Date().toISOString(),
                totalCount: null,
              };
            },
          },
          {
            recordType: 'purchase_order',
            columns: viewReaderKeys('procurement'),
          },
        ),
      },
      trace: (value) => ({
        traceId: 'trace',
        spanId: 'span',
        requestId: value.requestId,
      }),
      validateRoles: async () => {},
    });
    const reader = context(tenant, people[1], 'admin');

    // A view saved in format 1 with the old attention filter keeps reading the same orders.
    const id = randomUUID();
    const now = new Date().toISOString();
    await owner.query(
      'INSERT INTO adaptive_views(tenant_id,id,revision,archived,updated_at,document) VALUES($1,$2,1,false,$3,$4)',
      [
        tenant,
        id,
        now,
        JSON.stringify({
          id,
          tenantId: tenant,
          ownerId: people[1],
          name: 'Overdue confirmations',
          description: '',
          sharing: { scope: 'private', roleIds: [] },
          revision: 1,
          archived: false,
          createdAt: now,
          updatedAt: now,
          query: {
            version: 1,
            domain: 'procurement',
            filters: { attention: 'confirmation_overdue', supplierId },
            customFilters: [],
            columns: ['reference', 'supplierName', 'attentionKey'],
            sort: null,
            groupBy: null,
            layout: 'table',
            metrics: [],
            charts: [],
            actions: [],
          },
        }),
      ],
    );
    const stored = await service.get(reader, id);
    const old = await service.preview(reader, stored.query);
    expect(JSON.parse(String(reads[0]?.where))).toEqual({
      match: 'all',
      conditions: expect.arrayContaining([
        { field: 'attention', op: 'any_of', value: ['confirmation_overdue'] },
        { field: 'supplier', op: 'any_of', value: [supplierId] },
      ]),
    });
    expect(old.items[0]).toMatchObject({
      supplier: 'Northstar Supply',
      attention: orders[0]!.attentionKey,
    });

    // A built-in view runs as the list's stage, with grouping and metrics in the engine.
    const summary = await service.preview(reader, {
      version: 2,
      domain: 'procurement',
      state: {
        segment: 'awaiting_confirmation',
        where: { match: 'all', conditions: [] },
        sort: null,
        group: { field: 'supplier', showEmpty: false },
        layout: 'table',
        density: 'comfortable',
        columns: [{ id: 'reference' }, { id: 'stage' }],
        properties: [],
        preview: false,
      },
      metrics: [{ id: 'orders', operation: 'count', field: null }],
      charts: [
        { id: 'by-stage', type: 'bar', groupBy: 'stage', metricId: 'orders' },
      ],
      actions: [],
    });
    expect(reads.at(-1)).toMatchObject({ stage: 'awaiting_confirmation' });
    expect(summary.aggregates).toEqual([
      { metricId: 'orders', value: 2, complete: true },
    ]);
    expect(summary.groups).toEqual([{ key: 'Northstar Supply', count: 2 }]);
    expect(summary.chartSeries[0]?.points).toEqual([
      { key: 'awaiting_confirmation', value: 2, count: 2 },
    ]);
  });

  it('refuses a format 2 view whose condition does not match the list', async () => {
    const service = views();
    await expect(
      service.create(context(tenant, people[1]), {
        commandId: randomUUID(),
        name: 'Broken',
        description: '',
        sharing: { scope: 'private', roleIds: [] },
        query: {
          version: 2,
          domain: 'orders',
          state: {
            segment: null,
            where: {
              match: 'all',
              conditions: [{ field: 'status', op: 'gt', value: 3 }],
            },
            sort: null,
            group: null,
            layout: 'table',
            density: 'comfortable',
            columns: [],
            properties: [],
            preview: false,
          },
          metrics: [],
          charts: [],
          actions: [],
        },
        reviewed: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message:
        'This view needs repair. status: This field does not support this operator.',
    });
  });
});
