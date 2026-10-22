import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import { until } from './helpers.mjs';

/** The case workflow that corrects Shopify stock from the ERP. */
export const stock = 'shopify-stock-correction';

/** Links LUMA-001, drifts the shop's stock and lets detection open the case. */
export async function driftedStock(f) {
  await f.pilot.observe({ check: false });
  expect(await f.pilot.link()).toEqual({ linked: 1, remaining: 0 });
  await f.pilot.detect();
  const incident = randomUUID();
  await f.call('runs/operations/incidents', {
    id: incident,
    kind: 'inventory-drift',
    target: 'LUMA-001',
  });
  await f.pilot.observe({ check: false });
  const opened = await stockCase(f);
  expect(opened, JSON.stringify(f.pilot.detectionErrors)).toBeDefined();

  return { incident, opened };
}

/** Runs detection passes until a new stock gap outlasts the journey's sync window. */
export async function stockCase(f) {
  return until(async () => {
    await f.pilot.detect();

    return (await f.pilot.detection.exceptions.list(f.actor)).find(
      (item) =>
        item.exceptionClass === 'inventory_mismatch' &&
        item.state !== 'resolved' &&
        !f.pilot.inventoryScenario?.matches(item),
    );
  }, 'detection opens the stock case after the sync window');
}

/** Reads the simulated shop's available units for LUMA-001. */
export const shopStock = async (f) =>
  (await f.call('runs/operations/skus/LUMA-001')).shops[0].available;
