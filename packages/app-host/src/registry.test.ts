import type { TenantContext } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import { describe, expect, it } from 'vitest';

import type { AppRepository } from './application/installations.js';
import { createAppService } from './application/installations.js';
import { type AppDefinition, createAppRegistry } from './index.js';

const app: AppDefinition = {
  manifest: {
    id: 'notes',
    name: 'Notes',
    description: 'Workspace notes',
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
};

const tenantId = '11111111-1111-4111-8111-111111111111';

function context(permissions: string[] | 'admin') {
  const member = builtInMembership(
    {
      id: '22222222-2222-4222-8222-222222222222',
      organizationId: tenantId,
      userId: '33333333-3333-4333-8333-333333333333',
    },
    permissions === 'admin' ? 'admin' : 'member',
  );

  return makeTenantContext(
    { userId: member.userId, sessionId: 'session' },
    {
      id: tenantId,
      name: 'Workspace',
      slug: 'workspace',
      dataRegion: 'EU',
      status: 'active',
    },
    permissions === 'admin'
      ? member
      : { ...member, permissions: new PermissionSet(permissions) },
    'request',
  );
}

function service(granted: string[] | null) {
  const repository = {
    installed: async () => (granted ? { version: 1, scopes: granted } : null),
  } as unknown as AppRepository;

  return createAppService(
    repository,
    createAppRegistry([app]),
    async (value: TenantContext) => value,
  );
}

describe('app registry', () => {
  it('boots with zero apps and accepts apps with UI and no connector', async () => {
    const empty = createAppRegistry();
    expect(empty.list()).toEqual([]);
    expect(empty.provider('removed')).toBeUndefined();
    expect(await empty.ready()).toBe(true);
    expect(createAppRegistry([app]).list()).toEqual([app.manifest]);
  });

  it('rejects duplicate app IDs and keeps catalog mutations isolated', () => {
    expect(() => createAppRegistry([app, app])).toThrow('duplicate');
    const registry = createAppRegistry([app]);
    registry.list()[0]!.ui.length = 0;
    expect(registry.list()[0]!.ui).toEqual(['page']);
  });

  it.each([
    ['a core key', 'orders.read', 'core permission'],
    ['a foreign namespace', 'shopify:notes.write', "another app's namespace"],
    ['a malformed key', 'notes:Write Notes', 'is not <appId>:<name>'],
  ])('rejects app permissions with %s', (_case, key, message) => {
    expect(() =>
      createAppRegistry([
        {
          manifest: {
            ...app.manifest,
            permissions: [{ ...app.manifest.permissions[0]!, key }],
            slotAccess: { page: 'orders.read' },
          },
        },
      ]),
    ).toThrow(message);
  });

  it('rejects colliding permissions, unknown scopes and undeclared slot access', () => {
    const permission = app.manifest.permissions[0]!;
    expect(() =>
      createAppRegistry([
        {
          manifest: {
            ...app.manifest,
            permissions: [permission, permission],
          },
        },
      ]),
    ).toThrow('declared twice');
    expect(() =>
      createAppRegistry([
        { manifest: { ...app.manifest, scopes: ['orders.write'] } },
      ]),
    ).toThrow('not a core permission');
    expect(() =>
      createAppRegistry([{ manifest: { ...app.manifest, slotAccess: {} } }]),
    ).toThrow('UI slot page');
  });

  it('names the permission that governs each app action and rejects unknown ones', () => {
    const registry = createAppRegistry([
      {
        manifest: {
          ...app.manifest,
          actionAccess: { 'orders.quantity.edit': 'notes:notes.write' },
        },
      },
    ]);
    expect(registry.actionPermission('notes', 'orders.quantity.edit')).toBe(
      'notes:notes.write',
    );
    expect(registry.actionPermission('notes', 'returns.refund')).toBeNull();
    expect(
      registry.actionPermission('other', 'orders.quantity.edit'),
    ).toBeNull();
    expect(() =>
      createAppRegistry([
        {
          manifest: {
            ...app.manifest,
            actionAccess: { 'orders.quantity.edit': 'notes:missing' },
          },
        },
      ]),
    ).toThrow('action orders.quantity.edit');
  });

  it('filters app decisions by the permissions each kind declares', async () => {
    const decision = {
      kind: 'inventory_correction',
      response: 'decide',
    } as unknown as Awaited<
      ReturnType<NonNullable<AppDefinition['decisions']>>
    >[number];
    const registry = createAppRegistry([
      {
        manifest: {
          ...app.manifest,
          decisionAccess: {
            inventory_correction: {
              view: 'orders.read',
              respond: 'notes:notes.write',
            },
          },
        },
        decisions: async () => [decision],
      },
    ]);
    const sources = registry.decisionSources(
      async (ctx, _app, permission) => ctx.permissions.has(permission),
      async () => true,
    );
    const list = (permissions: string[]) =>
      sources[0]!.decisions(context(permissions));
    expect(await list([])).toEqual([]);
    expect(await list(['orders.read'])).toEqual([
      { ...decision, response: 'view_only' },
    ]);
    expect(await list(['orders.read', 'notes:notes.write'])).toEqual([
      decision,
    ]);
  });
});

describe('app operations', () => {
  const operation = {
    app: 'notes',
    permission: 'notes:notes.write',
    scopes: ['orders.read'],
  };

  it('allows an operation only when person, app scopes and app permission all allow it', async () => {
    const granted = service(['orders.read']);
    await expect(
      granted.requirePermission(
        context(['notes:notes.write', 'orders.read']),
        operation,
      ),
    ).resolves.toBeUndefined();
    await expect(
      granted.requirePermission(context('admin'), operation),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['the app permission', ['orders.read'], ['orders.read']],
    ['the person scope', ['notes:notes.write'], ['orders.read']],
    ['the app scope', ['notes:notes.write', 'orders.read'], []],
  ])('rejects the operation without %s', async (_case, held, scopes) => {
    await expect(
      service(scopes).requirePermission(context(held), operation),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects operations for uninstalled apps and other apps’ permissions', async () => {
    await expect(
      service(null).requirePermission(context('admin'), operation),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      service(['orders.read']).requirePermission(context('admin'), {
        app: 'notes',
        permission: 'shopify:fulfillment_recovery.run',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('only installs with the exact requested scopes the installer holds', async () => {
    let installed: string[] | undefined;
    const apps = createAppService(
      {
        change: async (
          _tenant: string,
          _actor: string,
          appId: string,
          _version: number | null,
          _installed: boolean,
          grant?: { scopes: string[] },
        ) => {
          installed = grant?.scopes;

          return {
            appId,
            status: 'installed',
            version: 1,
            updatedAt: new Date(0).toISOString(),
            grantedScopes: grant?.scopes ?? [],
          };
        },
      } as unknown as AppRepository,
      createAppRegistry([app]),
      async (value: TenantContext) => value,
    );
    await expect(
      apps.install(context(['apps.manage']), 'notes', null, ['orders.read']),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      apps.install(context('admin'), 'notes', null, []),
    ).rejects.toMatchObject({ statusCode: 409 });
    await apps.install(context('admin'), 'notes', null, ['orders.read']);
    expect(installed).toEqual(['orders.read']);
  });
});
