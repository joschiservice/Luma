import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createAppHost } from '@luma/app-catalog';
import type { AppFactory } from '@luma/app-host';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const actorId = '00000000-0000-4000-8000-0000000000ad';
const fixtureApp: AppFactory = () => ({
  manifest: {
    id: 'fixture',
    name: 'Fixture',
    description: 'Test connection',
    version: '1.0.0',
    category: 'utility',
    ui: ['settings'],
    connectionTypes: [{ kind: 'fixture', name: 'Fixture' }],
    permissions: [],
    scopes: [],
    slotAccess: { settings: 'connections.manage' },
  },
  connector: {
    appId: 'fixture',
    provider: 'fixture',
    targets: ['fixture'],
    validate: (input) => input,
    credentials: (_target, input) => input as { token: string },
    verify: async () => ['products.read'],
    build: async () => {
      throw new Error('Not used');
    },
  },
});
const uiApp: AppFactory = () => ({
  manifest: {
    id: 'notes',
    name: 'Notes',
    description: 'Notes',
    version: '1.0.0',
    category: 'utility',
    ui: ['page'],
    connectionTypes: [],
    permissions: [
      {
        key: 'notes:notes.write',
        label: 'Write notes',
        description: 'Create and edit workspace notes.',
        consequential: false,
      },
    ],
    scopes: ['orders.read'],
    slotAccess: { page: 'notes:notes.write' },
  },
});

describe.skipIf(!databaseUrl)('workspace app lifecycle on PostgreSQL', () => {
  const name = `apps_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  let owner: Pool;
  let runtime: Pool;
  const keys = new Map([['test', randomBytes(32)]]);
  const context = (
    id: string = randomUUID(),
    role: 'admin' | 'member' = 'admin',
  ) =>
    makeTenantContext(
      { userId: actorId, sessionId: 'session' },
      { id, name: 'Store', slug: 'store', dataRegion: 'EU', status: 'active' },
      builtInMembership(
        { id: 'membership', organizationId: id, userId: actorId },
        role,
      ),
      randomUUID(),
    );
  const host = (factories: readonly AppFactory[] = [fixtureApp, uiApp]) =>
    createAppHost(createTenantDatabase(runtime), {
      activeKeyId: 'test',
      keys,
      refreshContext: async (c) => c,
      factories,
      env: {},
    });
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    owner = new Pool({ connectionString: url.toString() });
    const lock = await admin.connect();
    try {
      await lock.query(
        "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
      );
      for (const file of [
        '0001_identity.sql',
        '0004_connector_installations.sql',
        '0023_workspace_settings.sql',
        '0024_workspace_apps.sql',
        '0054_workspace_roles.sql',
        '0055_workspace_app_scopes.sql',
        '0074_connection_write_mode_audit.sql',
      ])
        await owner.query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            'utf8',
          ),
        );
    } finally {
      await lock.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
      lock.release();
    }
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(`GRANT luma_connectors TO "${name}"`);
    url.username = name;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString() });
  }, 30000);
  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.end();
  }, 30000);
  it('requires installation, revokes all connections, retains history and never revives old credentials on reinstall', async () => {
    const ctx = context(),
      app = host();
    const input = {
      label: 'Test',
      target: { kind: 'fixture' },
      permissions: ['products.read'],
      credentials: { token: 'secret' },
    };
    await expect(app.connections.install(ctx, input)).rejects.toThrow(
      'Install this app',
    );
    await app.apps.install(ctx, 'fixture', null, []);
    const first = await app.connections.install(ctx, input),
      second = await app.connections.install(ctx, input);
    await app.connections.check(ctx, first.id, 1);
    await app.connections.check(ctx, second.id, 1);
    expect(
      (await app.connections.credential(ctx, first.id, 'products.read'))
        .credentials.token,
    ).toBe('secret');
    await app.apps.uninstall(ctx, 'fixture', 1);
    expect((await app.connections.list(ctx)).map((c) => c.status)).toEqual([
      'disconnected',
      'disconnected',
    ]);
    await expect(
      app.connections.credential(ctx, first.id, 'products.read'),
    ).rejects.toThrow();
    expect(
      (
        await owner.query(
          'SELECT secret FROM connector_installations WHERE tenant_id=$1',
          [ctx.tenantId],
        )
      ).rows,
    ).toEqual([{ secret: null }, { secret: null }]);
    expect(
      (
        await owner.query(
          'SELECT * FROM connector_lifecycle_events WHERE tenant_id=$1',
          [ctx.tenantId],
        )
      ).rowCount,
    ).toBe(6);
    await app.apps.install(ctx, 'fixture', 2, []);
    await expect(
      app.connections.credential(ctx, first.id, 'products.read'),
    ).rejects.toThrow();
    expect((await app.apps.list(ctx)).installations[0]?.version).toBe(3);
  });
  it('derives management actions from the current app for legacy connection documents', async () => {
    const ctx = context();
    const app = host([
      (context) => {
        const definition = fixtureApp(context);

        return {
          ...definition,
          connector: { ...definition.connector!, management: [] },
        };
      },
    ]);
    await app.apps.install(ctx, 'fixture', null, []);
    const connection = await app.connections.install(ctx, {
      label: 'Legacy',
      target: { kind: 'fixture' },
      permissions: ['products.read'],
      credentials: { token: 'secret' },
    });
    await owner.query(
      "UPDATE connector_installations SET document=document - 'management' WHERE tenant_id=$1 AND id=$2",
      [ctx.tenantId, connection.id],
    );
    expect((await app.connections.list(ctx))[0]?.management).toEqual([]);
    expect((await host([]).connections.list(ctx))[0]?.management).toEqual([]);
  });

  it('enforces roles, tenant isolation and optimistic versions', async () => {
    const ctx = context(),
      app = host();
    await expect(
      app.apps.install(context(ctx.tenantId, 'member'), 'notes', null, [
        'orders.read',
      ]),
    ).rejects.toThrow();
    await app.apps.install(ctx, 'notes', null, ['orders.read']);
    expect((await app.apps.list(context())).installations).toEqual([]);
    const direct = await createTenantDatabase(runtime).transaction(
      context().tenantId,
      (tx) => tx.query('SELECT * FROM workspace_apps'),
    );
    expect(direct.rows).toEqual([]);
    await expect(app.apps.uninstall(ctx, 'notes', 2)).rejects.toThrow(
      'changed',
    );
    const concurrent = await Promise.allSettled([
      app.apps.uninstall(ctx, 'notes', 1),
      app.apps.uninstall(ctx, 'notes', 1),
    ]);
    expect(
      concurrent.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
  });
  it('keeps the host usable when an app package is absent', async () => {
    const ctx = context();
    await host().apps.install(ctx, 'notes', null, ['orders.read']);
    const empty = host([]);
    expect(empty.registry.list()).toEqual([]);
    expect(empty.providerCatalog.list()).toEqual([]);
    expect((await empty.apps.list(ctx)).installations).toHaveLength(1);
    await expect(empty.apps.requireInstalled(ctx, 'notes')).rejects.toThrow(
      'unavailable',
    );
    await empty.apps.uninstall(ctx, 'notes', 1);
  });
  it('installs UI-only apps without connector encryption configuration', async () => {
    const ctx = context();
    const app = createAppHost(createTenantDatabase(runtime), {
      refreshContext: async (c) => c,
      factories: [uiApp],
      env: {},
    });
    await app.apps.install(ctx, 'notes', null, ['orders.read']);
    expect(await app.apps.requireInstalled(ctx, 'notes')).toBe(1);
  });
  it('rolls back connection revocation when an app cleanup hook fails', async () => {
    const failing: AppFactory = (context) => ({
      ...fixtureApp(context),
      uninstalled: async () => {
        throw new Error('Cleanup failed');
      },
    });
    const ctx = context(),
      app = host([failing]);
    await app.apps.install(ctx, 'fixture', null, []);
    const connection = await app.connections.install(ctx, {
      label: 'Test',
      target: { kind: 'fixture' },
      permissions: ['products.read'],
      credentials: { token: 'secret' },
    });
    await app.connections.check(ctx, connection.id, 1);
    await expect(app.apps.uninstall(ctx, 'fixture', 1)).rejects.toThrow(
      'Cleanup failed',
    );
    expect(await app.apps.requireInstalled(ctx, 'fixture')).toBe(1);
    expect(
      (await app.connections.credential(ctx, connection.id, 'products.read'))
        .credentials.token,
    ).toBe('secret');
  });
  it('rejects late credential persistence after uninstall at the database boundary', async () => {
    const ctx = context(),
      app = host();
    await app.apps.install(ctx, 'fixture', null, []);
    const connection = await app.connections.install(ctx, {
      label: 'Test',
      target: { kind: 'fixture' },
      permissions: ['products.read'],
      credentials: { token: 'secret' },
    });
    await app.apps.uninstall(ctx, 'fixture', 1);
    await expect(
      createTenantDatabase(runtime).transaction(ctx.tenantId, (tx) =>
        tx.query(
          'UPDATE connector_installations SET secret=\'late\',document=document || \'{"status":"active"}\'::jsonb WHERE tenant_id=$1 AND id=$2',
          [ctx.tenantId, connection.id],
        ),
      ),
    ).rejects.toThrow('App is not installed');
    await app.apps.install(ctx, 'fixture', 2, []);
    await expect(
      createTenantDatabase(runtime).transaction(ctx.tenantId, (tx) =>
        tx.query(
          'UPDATE connector_installations SET secret=\'late\',document=document || \'{"status":"active"}\'::jsonb WHERE tenant_id=$1 AND id=$2',
          [ctx.tenantId, connection.id],
        ),
      ),
    ).rejects.toThrow('App is not installed');
  });
});
