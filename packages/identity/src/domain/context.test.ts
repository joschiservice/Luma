import { conflict, notFound, ServiceError } from '@luma/platform';
import { expect, it } from 'vitest';

import {
  AccountDisabledError,
  hasPermission,
  makeTenantContext,
  MembershipSuspendedError,
  pausesBackgroundWork,
  requirePermission,
  requireTenant,
  WorkspaceInactiveError,
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

it.each(['suspended', 'closed'] as const)(
  'rejects a %s workspace as not found, distinguishable from a missing membership',
  (status) => {
    const role = builtInReference('owner');
    const member = {
      id: 'm',
      organizationId: 't',
      userId: 'u',
      role,
      permissions: PermissionSet.forRole(role),
    };
    const resolve = (userId: string) => () =>
      makeTenantContext(
        { userId, sessionId: 's' },
        { ...organization, status },
        member,
        'request',
      );

    expect(resolve('u')).toThrow(WorkspaceInactiveError);
    expect(resolve('u')).toThrow(
      expect.objectContaining({ statusCode: 404, code: 'NOT_FOUND' }),
    );
    expect(resolve('other')).toThrow(ServiceError);
    expect(resolve('other')).not.toThrow(WorkspaceInactiveError);
  },
);

it('rejects a suspended membership with its own code and keeps its role for reactivation', () => {
  const role = builtInReference('admin');
  const member = {
    id: 'm',
    organizationId: 't',
    userId: 'u',
    role,
    permissions: PermissionSet.forRole(role),
  };
  const resolve = (status: 'active' | 'suspended') => () =>
    makeTenantContext(
      { userId: 'u', sessionId: 's' },
      organization,
      { ...member, status },
      'request',
    );

  expect(resolve('suspended')).toThrow(MembershipSuspendedError);
  expect(resolve('suspended')).toThrow(
    expect.objectContaining({ statusCode: 403, code: 'ACCESS_SUSPENDED' }),
  );
  expect(resolve('active')().actor.role).toEqual(role);
  // An inactive workspace takes precedence, so background work pauses either way.
  expect(() =>
    makeTenantContext(
      { userId: 'u', sessionId: 's' },
      { ...organization, status: 'suspended' },
      { ...member, status: 'suspended' },
      'request',
    ),
  ).toThrow(WorkspaceInactiveError);
});

it('rejects a disabled account in every workspace, before its membership status', () => {
  const role = builtInReference('owner');
  const resolve = (status: 'active' | 'suspended') => () =>
    makeTenantContext(
      { userId: 'u', sessionId: 's' },
      organization,
      {
        id: 'm',
        organizationId: 't',
        userId: 'u',
        role,
        status,
        accountDisabled: true,
        permissions: PermissionSet.forRole(role),
      },
      'request',
    );

  expect(resolve('active')).toThrow(AccountDisabledError);
  expect(resolve('suspended')).toThrow(AccountDisabledError);
  // Background work handles it like a suspended member.
  expect(resolve('active')).toThrow(MembershipSuspendedError);
  expect(resolve('active')).toThrow(
    expect.objectContaining({ statusCode: 403, code: 'ACCESS_SUSPENDED' }),
  );
});

it('pauses background work only for an inactive workspace or a suspended member', () => {
  expect(pausesBackgroundWork(new WorkspaceInactiveError())).toBe(true);
  expect(pausesBackgroundWork(new MembershipSuspendedError())).toBe(true);
  expect(pausesBackgroundWork(new AccountDisabledError())).toBe(true);
  expect(pausesBackgroundWork(notFound('Removed'))).toBe(false);
  expect(pausesBackgroundWork(new Error('Unavailable'))).toBe(false);
});

it('treats service errors and identity errors as one error type', () => {
  const thrown = notFound('Order not found');

  expect(thrown).toBeInstanceOf(ServiceError);
  expect(conflict('Changed')).toBeInstanceOf(ServiceError);
  expect(new WorkspaceInactiveError()).toBeInstanceOf(ServiceError);
  expect(thrown).toMatchObject({
    statusCode: 404,
    code: 'NOT_FOUND',
    message: 'Order not found',
  });
});
