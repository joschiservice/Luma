import { journal } from '@luma/simulator-core';
import { stock } from '@luma/simulator-shopify';

import type { Run } from './run.js';
import { advanceRun, mutate } from './run.js';

export interface OperationalScenario {
  id: string;
  kind: 'inventory-mismatch';
  status: 'injected' | 'recovered';
  injectedAt: number;
  recoveredAt?: number;
  resources: { jtlItem: string; shopifyItem: string; shopifyLocation: string };
}

/** Injects one stock mismatch per run. Reusing an ID returns its original scenario without another mutation. */
export function injectInventoryMismatch(
  run: Run,
  id: string,
): OperationalScenario {
  const previous = run.operationalScenarios.find(
    (scenario) => scenario.id === id,
  );
  if (previous) return previous;
  if (
    run.operationalScenarios.some((scenario) => scenario.status === 'injected')
  )
    throw new Error('Match stock before creating another mismatch');
  const available = Number(
    run.jtl.items.find((item) => item.id === '2')!.stockAvailable,
  );
  const quantity = available + 10 + stock(run.shopify, '2').reserved;
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 2147483647)
    throw new Error('Stock is outside the supported scenario range');
  run.clock.running = false;
  advanceRun(run, 1);
  mutate(run, 'shopify', { kind: 'stock', id: '2', quantity });
  const scenario: OperationalScenario = {
    id,
    kind: 'inventory-mismatch',
    status: 'injected',
    injectedAt: run.clock.now,
    resources: {
      jtlItem: '2',
      shopifyItem: 'gid://shopify/InventoryItem/2',
      shopifyLocation: 'gid://shopify/Location/2',
    },
  };
  run.operationalScenarios.push(scenario);
  journal(run.clock, 'scenario-injected', scenario);

  return scenario;
}

/** Matches Shopify availability to current JTL stock, preserving Shopify reservations. Repeated recovery is a no-op. */
export function recoverInventoryMismatch(
  run: Run,
  id: string,
): OperationalScenario {
  const scenario = run.operationalScenarios.find((item) => item.id === id);
  if (!scenario) throw new Error('Scenario not found');
  if (scenario.status === 'recovered') return scenario;
  const quantity =
    Number(run.jtl.items.find((item) => item.id === '2')!.stockAvailable) +
    stock(run.shopify, '2').reserved;
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 2147483647)
    throw new Error('Stock is outside the supported scenario range');
  advanceRun(run, 1);
  mutate(run, 'shopify', { kind: 'stock', id: '2', quantity });
  scenario.status = 'recovered';
  scenario.recoveredAt = run.clock.now;
  journal(run.clock, 'scenario-recovered', { id });

  return scenario;
}
