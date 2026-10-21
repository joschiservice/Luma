import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { caseWorkflowFixture } from './case-workflows-fixture.mjs';
import { stock, stockCase } from './case-workflows-stock-fixture.mjs';
import { until } from './helpers.mjs';

test('the simulator demo turns workflows on and shows a scenario’s run on the scorecard', async (t) => {
  const f = await caseWorkflowFixture(t, {
    demo: { workflows: true, detection: 'demo' },
  });
  await f.pilot.observe({ check: false });
  await f.pilot.link();
  // Supplier links read JTL, so the demo completes over passes, as in the running pilot.
  await until(
    async () => {
      const done = await f.pilot.demo();

      return done.workflows === 7 && done.suppliers === 1 && done.rules === 1;
    },
    'demo setup completes',
    15_000,
  );
  expect(await f.pilot.demo()).toEqual({
    workflows: 7,
    suppliers: 1,
    rules: 1,
  });
  for (const id of [stock, 'shopify-hold-release', 'connection-sync-check'])
    expect(
      (await f.request(`/workflows/${id}`)).summary.readiness.enablement,
    ).toBe('enabled');
  const setup = await f.request(
    '/workflows/inventory-replenishment/replenishment',
  );
  expect(setup.rules).toEqual([
    expect.objectContaining({
      sku: 'LUMA-001',
      active: true,
      minimum:
        setup.positions.find(
          (item) =>
            item.sku === 'LUMA-001' &&
            item.connectionId === f.manifest.connections.jtl,
        ).available + 5,
    }),
  ]);

  // The owner turned the workflows on, so the run's change waits for the signed-in admin.
  await f.pilot.detect();
  const [incident] = await f.call('runs/operations/scenarios', {
    id: randomUUID(),
    scenario: 'stock-correction',
  });
  await f.pilot.observe({ check: false });
  await stockCase(f);
  await f.pilot.caseWorkflows.tick(await f.pilot.context());
  const [run] = await f.runs(stock);
  await f.waitFor(stock, run.id, 'awaiting_decision');
  await until(
    async () =>
      (await f.call('runs/operations/incidents')).find(
        (item) => item.id === incident.id,
      )?.detection?.workflow?.state === 'awaiting_decision',
    'scorecard shows the waiting run',
    15_000,
  );
});
