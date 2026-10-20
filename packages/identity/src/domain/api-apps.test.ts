import { expect, it } from 'vitest';

import {
  apiAppPermissions,
  apiAppScopes,
  apiAppScopesFor,
} from './api-apps.js';
import { isPermission } from './permissions.js';
import { builtInReference, PermissionSet } from './roles.js';

const memberPermissions = PermissionSet.forRole(builtInReference('member'));

it('grants only read permissions from the catalog', () => {
  expect(apiAppScopes.every(isPermission)).toBe(true);
  expect(apiAppScopes.every((scope) => scope.endsWith('.read'))).toBe(true);
});

it('sorts and deduplicates requested scopes the person holds', () => {
  expect(
    apiAppScopesFor(
      ['orders.read', 'customers.read', 'orders.read'],
      memberPermissions,
    ),
  ).toEqual(['customers.read', 'orders.read']);
});

it.each([
  { scopes: [], status: 422 },
  { scopes: ['members.manage'], status: 422 },
  { scopes: ['orders.read', 'shopify:stock.write'], status: 422 },
])('refuses $scopes', ({ scopes, status }) => {
  expect(() => apiAppScopesFor(scopes, memberPermissions)).toThrow(
    expect.objectContaining({ statusCode: status }),
  );
});

it('refuses scopes the person doesn’t hold', () => {
  expect(() =>
    apiAppScopesFor(['orders.read'], new PermissionSet(['customers.read'])),
  ).toThrow(expect.objectContaining({ statusCode: 403 }));
});

it('narrows to scopes the role still grants, without app permissions', () => {
  const owner = PermissionSet.forRole(builtInReference('owner'));
  const narrowed = apiAppPermissions(owner, ['orders.read', 'returns.read']);

  expect([...narrowed]).toEqual(['orders.read', 'returns.read']);
  expect(narrowed.has('members.manage')).toBe(false);
  expect(narrowed.has('shopify:stock.write')).toBe(false);
  expect([
    ...apiAppPermissions(new PermissionSet(['orders.read']), [
      'orders.read',
      'returns.read',
      'members.manage',
    ]),
  ]).toEqual(['orders.read']);
});
