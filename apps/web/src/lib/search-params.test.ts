import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { expect, it } from 'vitest';
import { z } from 'zod';

// A runnable example of route-owned view state; no dummy production route/store.
it('validates URL view state via Standard Schema', () => {
  const root = createRootRoute();
  const items = createRoute({
    getParentRoute: () => root,
    path: '/items',
    validateSearch: z.object({
      view: z.enum(['list', 'board']).catch('list').default('list'),
    }),
  });
  const router = createRouter({
    routeTree: root.addChildren([items]),
    history: createMemoryHistory({ initialEntries: ['/items?view=invalid'] }),
  });
  expect(
    router.matchRoutes('/items', { view: 'invalid' }).at(-1)?.search,
  ).toMatchObject({
    view: 'list',
  });
  expect(
    router.matchRoutes('/items', { view: 'board' }).at(-1)?.search,
  ).toMatchObject({
    view: 'board',
  });
});
