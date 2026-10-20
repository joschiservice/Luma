import {
  apiAppLifetimeDays,
  apiContract,
  contractRoutes,
} from '@luma/api-contract';
import { expect, it } from 'vitest';

import { apiAppLifetimes, apiAppScopes } from '../domain/api-apps.js';
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

it('grants API apps exactly the permissions public routes require, and only for reads', () => {
  const routes = contractRoutes(apiContract).filter(
    (route) => route.meta.publicApi,
  );
  const required = new Set(
    routes.flatMap((route) => {
      const access = route.meta.access;

      return access && 'permission' in access
        ? typeof access.permission === 'string'
          ? [access.permission]
          : [...access.permission]
        : [];
    }),
  );

  expect(routes.map((route) => route.method)).toEqual(routes.map(() => 'GET'));
  expect(
    routes.every((route) =>
      route.path.startsWith('/v1/organizations/{organizationId}/'),
    ),
  ).toBe(true);
  expect([...required].sort()).toEqual([...apiAppScopes].sort());
  expect([...apiAppLifetimeDays]).toEqual([...apiAppLifetimes]);
});

it('marks personal data only on public routes, including customer reads', () => {
  const marked = contractRoutes(apiContract).filter(
    (route) => route.meta.personalData,
  );

  expect(marked.every((route) => route.meta.publicApi)).toBe(true);
  expect(
    contractRoutes(apiContract)
      .filter(
        (route) =>
          route.meta.publicApi &&
          route.meta.access &&
          'permission' in route.meta.access &&
          route.meta.access.permission === 'customers.read',
      )
      .every((route) => route.meta.personalData),
  ).toBe(true);
});
