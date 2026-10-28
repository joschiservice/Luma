import type { AnyRoute } from '@tanstack/react-router';
import { expect, it } from 'vitest';

import { Route as app } from '../../routes/app';
import { routeTree } from '../../routeTree.gen';

it('keeps every route below the server-rendered /app layout in the browser', () => {
  // Importing the tree attaches the layout's children.
  expect(routeTree.children).toBeDefined();
  const children = (app.children ?? []) as AnyRoute[];

  expect(app.options.ssr).toBeUndefined();
  expect(children.length).toBeGreaterThan(0);
  for (const { options } of children) {
    const route = 'id' in options ? options.id : undefined;
    expect({ route, ssr: options.ssr }).toEqual({ route, ssr: false });
  }
});
