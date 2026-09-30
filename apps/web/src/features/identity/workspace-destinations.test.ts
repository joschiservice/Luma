import { expect, it } from 'vitest';

import { destinationFor } from './workspace-destinations';

it('finds the destination that owns a workspace URL', () => {
  expect(destinationFor('/app/org/exceptions?view=active').path).toBe(
    'exceptions',
  );
  expect(destinationFor('/app/org/workflows/replenish#runs').path).toBe(
    'workflows',
  );
  expect(destinationFor('/app/org/orders/7f3c?view=overdue').path).toBe(
    'orders',
  );
  expect(destinationFor('/app/org/products/5a1d?view=differs').path).toBe(
    'products',
  );
  expect(destinationFor('/app/org/overview').path).toBe('home');
  expect(destinationFor('/app/org/connections').path).toBe('apps');
  expect(destinationFor('/app/org/unknown').path).toBe('home');
});
