import type { RouteAccess } from '@luma/api-contract';
import { apiContract } from '@luma/api-contract';
import { expect, it } from 'vitest';

import { isPermission } from '../domain/permissions.js';

type Route = { method: string; path: string; metadata?: unknown };

function routes(node: object, prefix: string[] = []): [string, Route][] {
  return Object.entries(node).flatMap(([key, value]: [string, unknown]) => {
    if (!value || typeof value !== 'object') return [];
    if ('method' in value && 'path' in value)
      return [[[...prefix, key].join('.'), value as Route]];

    return routes(value, [...prefix, key]);
  });
}

it('declares a known permission, or open member access, on every tenant route', () => {
  const tenant = routes(apiContract).filter(([, route]) =>
    route.path.startsWith('/v1/organizations/:organizationId'),
  );
  expect(tenant.length).toBeGreaterThan(100);
  const invalid = tenant.flatMap(([name, route]) => {
    const access = route.metadata as RouteAccess | undefined;
    if (access && 'access' in access && access.access === 'member') return [];
    const permissions =
      access && 'permission' in access
        ? typeof access.permission === 'string'
          ? [access.permission]
          : [...access.permission]
        : [];

    return permissions.length && permissions.every(isPermission)
      ? []
      : [`${name} ${route.method} ${route.path}`];
  });
  expect(invalid).toEqual([]);
});
