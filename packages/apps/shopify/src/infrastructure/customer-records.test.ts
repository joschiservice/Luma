import { describe, expect, it } from 'vitest';

import { recordInput } from '../domain/records.js';
import { customerSearchQuery } from './customer-records.js';

const connectionId = '11111111-1111-4111-8111-111111111111';

describe('customer search input', () => {
  it('quotes search operators as literal text', () => {
    expect(
      customerSearchQuery({ field: 'email', value: 'a" OR email:*' }),
    ).toBe('email:"a\\" OR email:*"');
    expect(customerSearchQuery({ field: 'order', value: '#1001' })).toBe(
      'name:"#1001"',
    );
  });
  it('rejects search on other kinds, detail search and unbounded queries', () => {
    for (const input of [
      { kind: 'Order', search: { field: 'email', value: 'x' } },
      {
        kind: 'Customer',
        id: 'gid://shopify/Customer/1',
        search: { field: 'name', value: 'x' },
      },
      { kind: 'Customer', search: { field: 'name', value: 'x'.repeat(121) } },
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
