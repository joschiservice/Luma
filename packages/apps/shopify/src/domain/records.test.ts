import { describe, expect, it } from 'vitest';

import { recordInput } from './records.js';

const connectionId = '11111111-1111-4111-8111-111111111111';

describe('Shopify record input', () => {
  it('reads one customer and pages its orders, but never lists or searches customers', () => {
    for (const input of [
      { kind: 'Customer' },
      { kind: 'Customer', search: { field: 'name', value: 'x' } },
      { kind: 'Order', id: 'gid://shopify/Order/1', cursor: 'next' },
    ])
      expect(recordInput.safeParse({ connectionId, ...input }).success).toBe(
        false,
      );
    expect(
      recordInput.safeParse({
        connectionId,
        kind: 'Customer',
        id: 'gid://shopify/Customer/1',
        cursor: 'next',
      }).success,
    ).toBe(true);
  });
});
