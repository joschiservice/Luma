import { expect, it } from 'vitest';

import { type FoundReturn, matchesCreation } from './return-creations.js';

const creation = {
  lines: [
    {
      orderLineId: 'canonical',
      source: { externalId: 'line', scopeKey: 'order' },
      quantity: 2,
    },
  ],
};
const found = (lines: FoundReturn['lines']): FoundReturn => ({
  observationId: 'observation',
  observedAt: '2026-10-11T00:00:00Z',
  externalId: 'return',
  number: null,
  lines,
});
const line = (quantity: string, externalId = 'line') => ({
  orderLine: { externalId, scopeKey: 'order' },
  quantity,
});

it('verifies total units across shipment lines without accepting duplicated or unmapped units', () => {
  expect(matchesCreation(creation, found([line('1'), line('1')]))).toBe(true);
  expect(matchesCreation(creation, found([line('2'), line('2')]))).toBe(false);
  expect(matchesCreation(creation, found([line('2', 'another')]))).toBe(false);
  expect(
    matchesCreation(creation, found([{ orderLine: null, quantity: '2' }])),
  ).toBe(false);
  expect(matchesCreation(creation, found([line('NaN')]))).toBe(false);
  expect(matchesCreation(creation, found([line('1.5')]))).toBe(false);
});
