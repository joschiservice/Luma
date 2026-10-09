import { apiContract, contractRoutes } from '@luma/api-contract';
import { expect, it } from 'vitest';

import { isPermission } from '../domain/permissions.js';

it('declares a known permission, or open member access, on every tenant route', () => {
  const tenant = contractRoutes(apiContract).filter((route) =>
    route.path.startsWith('/v1/organizations/{organizationId}'),
  );
  expect(tenant.length).toBeGreaterThan(100);
  const invalid = tenant.flatMap((route) => {
    const access = route.meta.access;
    if (access && 'access' in access && access.access === 'member') return [];
    const permissions =
      access && 'permission' in access
        ? typeof access.permission === 'string'
          ? [access.permission]
          : [...access.permission]
        : [];

    return permissions.length && permissions.every(isPermission)
      ? []
      : [`${route.key} ${route.method} ${route.path}`];
  });
  expect(invalid).toEqual([]);
});
