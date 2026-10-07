import { describe, expect, it } from 'vitest';

import type { Incident } from '../engine/world.js';
import { type LumaCase, viewIncident } from './scorecard.js';

const startedAt = Date.parse('2026-10-07T10:00:00.000Z');
const drift: Incident = {
  id: 'incident',
  kind: 'inventory-drift',
  origin: 'injected',
  status: 'active',
  startedAt,
  endedAt: null,
  instance: 'shopify',
  summary: 'Drift',
  resources: [
    {
      instance: 'shopify',
      kind: 'InventoryItem',
      id: 'gid://shopify/InventoryItem/341',
      label: 'SKU',
    },
    {
      instance: 'shopify',
      kind: 'Location',
      id: 'gid://shopify/Location/1',
      label: 'Hamburg Hub',
    },
  ],
  detail: {},
};
const stockCase = (id: string, item: string): LumaCase => ({
  id,
  exceptionClass: 'inventory_mismatch',
  detectedAt: new Date(startedAt + 60_000).toISOString(),
  resolvedAt: null,
  closedWithoutVerification: false,
  verified: false,
  instances: ['shopify', 'jtl'],
  identifiers: [item, 'gid://shopify/Location/1'],
  url: null,
  workflow: { name: 'Correct Shopify stock', state: 'verified', url: 'u' },
});

describe('scorecard matching', () => {
  it('matches a stock incident to its own SKU’s case, not another case at the location', () => {
    const view = viewIncident(
      drift,
      [
        stockCase('other', 'gid://shopify/InventoryItem/7'),
        stockCase('own', 'gid://shopify/InventoryItem/341'),
      ],
      startedAt + 120_000,
    );

    expect(view.detection).toMatchObject({
      state: 'detected',
      caseId: 'own',
      workflow: { state: 'verified' },
    });
  });
});
