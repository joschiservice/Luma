import { expect, test } from 'vitest';

import { until } from './helpers.mjs';
import {
  quantityChangeFixture,
  workflow,
} from './order-quantity-change-fixture.mjs';

test('a lost Shopify commit response is reconciled from the order and never sent again', async (t) => {
  const f = await quantityChangeFixture(t, { imported: true });
  await f.activate(workflow);
  await f.changeQuantity('1');
  const opened = await f.caseOpened();
  const run = await f.run();
  await f.waitFor(workflow, run.id, 'waiting');
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'shopify',
      operation: 'orders.quantity.edit',
      kind: 'response-loss',
      remaining: 1,
    },
  });
  await f.answer(run.id, 'Adjusted');
  const proposalId = await f.approve(run.id);
  await f.waitFor(workflow, run.id, 'verified');
  expect(await f.commits()).toHaveLength(1);
  const audit = await f.db.owner.query(
    "SELECT document->>'eventType' AS event FROM audit_entries WHERE tenant_id=$1 AND document->>'proposalId'=$2",
    [f.manifest.organizationId, proposalId],
  );
  expect(audit.rows.map((row) => row.event)).toContain('execution.reconciled');
  await until(async () => {
    await f.pilot.detect();

    return (
      (await f.pilot.detection.exceptions.get(f.actor, opened.id)).state ===
      'resolved'
    );
  }, 'detection verifies the case');
  expect(await f.commits()).toHaveLength(1);
}, 300_000);
