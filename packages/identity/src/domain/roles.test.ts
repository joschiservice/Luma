import { describe, expect, it } from 'vitest';

import type { Permission } from './permissions.js';
import { permissionCatalog } from './permissions.js';
import type { BuiltInRoleKey } from './roles.js';
import { builtInReference, builtInRoles, PermissionSet } from './roles.js';

const managers: BuiltInRoleKey[] = ['owner', 'admin'];
const everyone: BuiltInRoleKey[] = ['owner', 'admin', 'member'];

/**
 * The role check each service performed before LUMA-135, and the permission that replaced it.
 * Built-in roles must answer exactly as the old check did.
 */
const migrated: [
  site: string,
  permission: Permission,
  allowed: BuiltInRoleKey[],
][] = [
  ['identity: change members', 'members.manage', managers],
  [
    'settings: workspace name and timezone',
    'workspace.settings.manage',
    managers,
  ],
  ['settings: approval policy', 'workspace.approval_policy.manage', managers],
  ['settings: invitations', 'members.manage', managers],
  ['policies: respond to approvals', 'decisions.respond', managers],
  ['execution: run actions', 'actions.execute', managers],
  ['desk: refresh proposals', 'actions.propose', managers],
  ['desk: escalate, verify and resolve', 'issues.manage', managers],
  ['desk: read reviews', 'issues.read', everyone],
  ['decisions: assign anyone', 'decisions.assign', managers],
  ['decisions: take and release own', 'decisions.self_assign', everyone],
  ['learning and measurement writes', 'issues.manage', managers],
  ['shadow evaluation', 'playbooks.activate', managers],
  ['workflow catalog reads', 'workflows.read', everyone],
  ['workflow drafts, generation and tests', 'workflows.author', managers],
  ['workflow publication', 'workflows.publish', managers],
  ['workflow triggers', 'workflows.triggers.manage', managers],
  ['playbook activation', 'playbooks.activate', managers],
  ['process activities and runs', 'actions.propose', managers],
  ['procurement reads', 'procurement.read', everyone],
  ['procurement writes', 'procurement.manage', managers],
  ['connections lifecycle', 'connections.manage', managers],
  ['imports, projections and ingestion', 'sync.manage', managers],
  ['app installation', 'apps.manage', managers],
  ['Ask Luma', 'assistant.use', everyone],
  ['activity reads', 'activity.read', everyone],
  ['restricted activity', 'activity.read_restricted', managers],
  ['order, stock, product and customer reads', 'orders.read', everyone],
  ['customer reads', 'customers.read', everyone],
  ['insights', 'insights.read', everyone],
];

describe('built-in roles', () => {
  it.each(migrated)(
    'keep pre-catalog access for %s',
    (_site, permission, allowed) => {
      for (const key of everyone)
        expect(
          PermissionSet.forRole(builtInReference(key)).has(permission),
          `${key} ${permission}`,
        ).toBe(allowed.includes(key));
    },
  );

  it('give Owner and Admin every core and app permission, and Member none of the app ones', () => {
    for (const key of managers) {
      const set = PermissionSet.forRole(builtInReference(key));
      expect(permissionCatalog.every((item) => set.has(item.key))).toBe(true);
      expect(set.has('jtl:purchase_orders.submit')).toBe(true);
    }
    expect(
      PermissionSet.forRole(builtInReference('member')).has(
        'jtl:purchase_orders.submit',
      ),
    ).toBe(false);
  });

  it('only reference catalog permissions', () => {
    const keys = new Set<string>(permissionCatalog.map((item) => item.key));
    for (const role of Object.values(builtInRoles))
      expect(role.permissions.filter((key) => !keys.has(key))).toEqual([]);
  });
});

describe('custom role grants', () => {
  const custom = {
    id: '00000000-0000-4000-8000-000000000001',
    key: 'custom' as const,
    name: 'Buyer',
    builtIn: false,
    revision: 1,
  };

  it('grant only stored, well-formed permissions and never new catalog entries', () => {
    const set = PermissionSet.forRole(custom, [
      'procurement.read',
      'jtl:purchase_orders.submit',
      'Unknown',
    ]);
    expect([...set]).toEqual([
      'jtl:purchase_orders.submit',
      'procurement.read',
    ]);
    expect(set.has('procurement.manage')).toBe(false);
  });

  it('cover another set only when holding all of it', () => {
    const admin = PermissionSet.forRole(builtInReference('admin'));
    const buyer = PermissionSet.forRole(custom, ['procurement.read']);
    expect(admin.covers(buyer)).toBe(true);
    expect(buyer.covers(admin)).toBe(false);
    expect(
      buyer.covers(PermissionSet.forRole(builtInReference('member'))),
    ).toBe(false);
  });
});
