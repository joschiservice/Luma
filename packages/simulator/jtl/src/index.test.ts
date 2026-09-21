import { expect, it } from 'vitest';

import { command, handle, seed } from './index.js';

it('preserves stock, fulfillment relationships, pagination and isolation', () => {
  const state = seed();
  const other = seed();
  command(state, { kind: 'order', id: '1', quantity: 3 }, 0);
  command(state, { kind: 'order', id: '2', quantity: 1 }, 0);
  command(state, { kind: 'ship', id: '1' }, 1000);
  expect(state.items[0]).toMatchObject({
    stockTotal: '97',
    stockReservedTotal: '1',
    stockAvailable: '96',
  });
  expect(state.noteLines[0]).toMatchObject({
    salesOrderLineItemId: '1',
    deliveryNoteId: '1',
  });
  const response = handle(
    state,
    {
      url: 'https://jtl.invalid/api/sales-orders?pageSize=1&pageNumber=2',
      method: 'GET',
      headers: { authorization: 'Wawi synthetic' },
      body: null,
    },
    0,
  );
  expect(response.body).toMatchObject({
    totalItems: 2,
    items: [{ id: '2' }],
    hasNextPage: false,
  });
  expect(other.orders).toEqual([]);
  expect(() => command(state, { kind: 'ship', id: '1' }, 2000)).toThrow(
    'already shipped',
  );
});
