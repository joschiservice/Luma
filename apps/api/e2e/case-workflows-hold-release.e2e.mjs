import { randomUUID } from 'node:crypto';

import { defaultConfiguration } from '@luma/exceptions';
import { expect, test } from 'vitest';

import { caseWorkflowFixture } from './case-workflows-fixture.mjs';
import { until } from './helpers.mjs';

test('releases an overdue fraud hold after approval and leaves warehouse progress to detection', async (t) => {
  const f = await caseWorkflowFixture(t, {
    imported: true,
    detection: {
      configuration: {
        ...defaultConfiguration,
        version: 'case-workflows-e2e',
        thresholds: { ...defaultConfiguration.thresholds, stuckSeconds: 1 },
      },
      holdOverdueSeconds: 1,
    },
  });
  const hold = 'shopify-hold-release';
  await f.activate(hold);
  await f.pilot.observe({ check: false });
  await f.call('runs/operations/incidents', {
    id: randomUUID(),
    kind: 'fraud-hold',
  });
  // A fulfillment read before its order waits for the next fulfillment read.
  await f.pilot.observe({ check: false });
  await f.pilot.observe({ check: false });
  await until(
    async () => {
      await f.pilot.detect();

      return (await f.pilot.detection.exceptions.list(f.actor)).some(
        (item) =>
          item.exceptionClass === 'stuck_fulfillment' &&
          item.state !== 'resolved',
      );
    },
    'overdue hold opens a stuck fulfillment',
    15_000,
  );
  // The fixture's other open orders are stuck too, but nothing holds them.
  const stuck = (await f.pilot.detection.exceptions.list(f.actor)).filter(
    (item) => item.exceptionClass === 'stuck_fulfillment',
  );
  let opened;
  for (const item of stuck)
    if (
      (await f.pilot.detection.exceptions.evidence(f.actor, item.id)).some(
        (evidence) => evidence.facts.holds?.length,
      )
    )
      opened = item;
  expect(opened).toBeDefined();
  await f.tick();
  const runs = await f.runs(hold);
  expect(runs).toHaveLength(stuck.length);
  const run = runs.find((item) => item.triggerEvidence.sourceId === opened.id);
  // Without a hold there is nothing to release; an unreadable order goes to a person.
  for (const other of runs.filter((item) => item !== run))
    await f.waitFor(hold, other.id, ['ended', 'escalated']);
  const waiting = await f.waitFor(hold, run.id, 'awaiting_decision');
  expect(
    waiting.processSteps.find((step) => step.stepId === 'hold').values,
  ).toMatchObject({
    ready: true,
    held: true,
    releasable: true,
    reason: 'HIGH_RISK_OF_FRAUD',
  });
  await f.request(
    '/apps/shopify/fulfillment-recovery-approve',
    { id: f.proposal(waiting, 'release-hold'), outcome: 'approved' },
    { cookie: f.approverCookie },
  );
  await f.wake(run.id);
  const verified = await f.waitFor(hold, run.id, 'verified');
  expect(
    verified.processSteps.find((step) => step.stepId === 'check-hold'),
  ).toMatchObject({ state: 'completed', values: { held: false } });
  // Releasing the hold isn't shipping the order; the case stays open until it progresses.
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(
    (await f.pilot.detection.exceptions.get(f.actor, opened.id)).state,
  ).not.toBe('resolved');
});
