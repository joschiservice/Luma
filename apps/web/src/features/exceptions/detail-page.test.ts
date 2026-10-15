import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { expect, it } from 'vitest';

import { createQueryClient } from '../../lib/query-client';
import { routeTree } from '../../routeTree.gen';
import { caseView } from './data';

const organizationId = '11111111-1111-4111-8111-111111111111';
const exceptionId = '22222222-2222-4222-8222-222222222222';

it('opens the full issue outside the inbox layout while preserving its return filters', () => {
  const router = createRouter({
    routeTree,
    context: { queryClient: createQueryClient() },
    history: createMemoryHistory(),
  });
  const search = {
    view: 'active' as const,
    severity: 'high' as const,
    cursor: 'retained-page',
    shadow: 'workflow-1',
  };
  const full = router.buildLocation({
    to: '/app/$organizationId/exceptions/$exceptionId/detail',
    params: { organizationId, exceptionId },
    search,
  });
  const matches = router.matchRoutes(full.pathname, full.search);
  expect(matches.map((match) => match.routeId)).toContain(
    '/app/$organizationId',
  );
  expect(matches.map((match) => match.routeId)).not.toContain(
    '/app/$organizationId/exceptions',
  );
  expect(matches.at(-1)?.routeId).toBe(
    '/app/$organizationId/exceptions_/$exceptionId/detail',
  );
  expect(matches.at(-1)?.search).toEqual(search);
  const back = router.buildLocation({
    to: '/app/$organizationId/exceptions/$exceptionId',
    params: { organizationId, exceptionId },
    search: full.search,
  });
  expect(back.pathname).toBe(
    `/app/${organizationId}/exceptions/${exceptionId}`,
  );
  expect(back.search).toEqual(search);
});

it('supports a direct full-page URL with default inbox state', () => {
  const router = createRouter({
    routeTree,
    context: { queryClient: createQueryClient() },
    history: createMemoryHistory(),
  });
  const matches = router.matchRoutes(
    `/app/${organizationId}/exceptions/${exceptionId}/detail`,
    { view: 'invalid', severity: 'invalid' },
  );
  // An unknown view stays in the URL and resolves to the default view; invalid filters drop.
  expect(matches.at(-1)?.search).toMatchObject({ view: 'invalid' });
  expect(caseView('invalid')).toBe('active');
  expect(matches.at(-1)?.search).toMatchObject({ severity: undefined });
  expect(matches.at(-1)?.params).toMatchObject({ organizationId, exceptionId });
});
