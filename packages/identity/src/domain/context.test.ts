import { expect, it } from 'vitest';

import {
  hasPermission,
  makeTenantContext,
  requirePermission,
  requireTenant,
} from './context.js';
import { builtInReference, PermissionSet } from './roles.js';

const organization = {
  id: 't',
  name: 'Tenant',
  slug: 'tenant',
  dataRegion: 'EU' as const,
  status: 'active' as const,
};

function contextFor(role: ReturnType<typeof builtInReference>) {
  return makeTenantContext(
    { userId: 'u', sessionId: 's' },
    organization,
    {
      id: 'm',
      organizationId: 't',
      userId: 'u',
      role,
      permissions: PermissionSet.forRole(role),
    },
    'request',
  );
}

it('freezes audit identity and rejects unauthorized tenant or permission use', () => {
  const context = contextFor(builtInReference('member'));
  expect(Object.isFrozen(context)).toBe(true);
  expect(Object.isFrozen(context.actor)).toBe(true);
  expect(Object.isFrozen(context.actor.role)).toBe(true);
  expect(() => requireTenant(context, 'foreign')).toThrow('Resource not found');
  expect(() => requirePermission(context, 'members.manage')).toThrow(
    'Your role does not allow this',
  );
  expect(() => requirePermission(context, 'orders.read')).not.toThrow();
});

it('grants app permissions to managing built-in roles and custom grants only', () => {
  expect(
    hasPermission(contextFor(builtInReference('admin')), 'shopify:x.respond'),
  ).toBe(true);
  expect(
    hasPermission(contextFor(builtInReference('member')), 'shopify:x.respond'),
  ).toBe(false);
  const custom = {
    id: '00000000-0000-4000-8000-000000000001',
    key: 'custom' as const,
    name: 'Buyer',
    builtIn: false,
    revision: 3,
  };
  const context = makeTenantContext(
    { userId: 'u', sessionId: 's' },
    organization,
    {
      id: 'm',
      organizationId: 't',
      userId: 'u',
      role: custom,
      permissions: PermissionSet.forRole(custom, [
        'procurement.read',
        'jtl:purchase_orders.submit',
        'not a permission',
      ]),
    },
    'request',
  );
  expect(hasPermission(context, 'procurement.read')).toBe(true);
  expect(hasPermission(context, 'jtl:purchase_orders.submit')).toBe(true);
  expect(hasPermission(context, 'jtl:orders.shipping_method.write')).toBe(
    false,
  );
  expect(hasPermission(context, 'procurement.manage')).toBe(false);
  expect([...context.permissions]).toEqual([
    'jtl:purchase_orders.submit',
    'procurement.read',
  ]);
});
