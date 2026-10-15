import { randomUUID } from 'node:crypto';

import { defaultConfiguration } from '@luma/exceptions';
import { expect, test } from 'vitest';

import { until } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

/**
 * The fixed test world links one product, so one unfollowed change counts as a stall, and a
 * change counts as unfollowed after one second instead of fifteen minutes.
 */
const configuration = {
  ...defaultConfiguration,
  version: `${defaultConfiguration.version}-stall-journey`,
  thresholds: {
    ...defaultConfiguration.thresholds,
    propagationSeconds: 1,
    oversellPropagationSeconds: 1,
    stallSeconds: 1,
    stallMinPositions: 1,
  },
};

test('a store that stops following stock changes opens one verified, scored and recurring stall case', async (t) => {
  // The test world never pushes stock to the shop on its own; ERP changes stay unfollowed until
  // the journey writes the shop, as a restarted stock sync would.
  const f = await setupSimulator(t, { detection: { configuration } });
  const actor = await f.pilot.operator();
  const { jtl, shopify } = f.manifest.connections;
  const command = (instance, body) =>
    f.call('runs/operations/control', {
      action: 'command',
      instance,
      command: body,
    });
  const cases = async (exceptionClass) =>
    (await f.pilot.detection.exceptions.list(actor)).filter(
      (incident) =>
        incident.exceptionClass === exceptionClass &&
        incident.subject.scope.includes(jtl) &&
        (incident.exceptionClass === 'stock_sync_stall'
          ? incident.subject.subjectId === shopify
          : incident.subject.scope.includes(shopify)),
    );
  const pass = async () => {
    await f.pilot.observe({ check: false });
    await f.pilot.detect();
  };
  const restock = async (quantity) => {
    await command('jtl', {
      kind: 'stock',
      itemId: '1',
      warehouse: '1',
      quantity,
    });
    await f.pilot.observe({ check: false });
  };
  // Writes the ERP's available stock, as Luma last read it for the case, to the shop.
  const followed = async (caseId) => {
    const [read] = (await f.pilot.detection.exceptions.evidence(actor, caseId))
      .filter((item) => item.source?.provider === 'jtl')
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    await command('shopify', {
      kind: 'available',
      variant: '1',
      location: '1',
      quantity: Number(read.facts.available),
    });
  };

  await f.pilot.observe({ check: false });
  expect(await f.pilot.link()).toEqual({ linked: 1, remaining: 0 });
  await f.pilot.detect();
  expect(await cases('stock_sync_stall')).toEqual([]);

  const incidentId = randomUUID();
  expect(
    await f.call('runs/operations/incidents', {
      id: incidentId,
      kind: 'stock-sync-stall',
    }),
  ).toMatchObject({ id: incidentId, status: 'active', instance: 'shopify' });
  // A restock reaches the ERP, but not the shop.
  await restock(400);
  const opened = await until(async () => {
    await pass();

    return (await cases('stock_sync_stall'))[0];
  }, 'the stall case');
  expect(opened).toMatchObject({
    severity: 'medium',
    subject: {
      ruleIdentity: 'stock-sync-follow',
      subjectKind: 'connection',
      subjectId: shopify,
      scope: [jtl],
    },
  });
  const evidence = await f.pilot.detection.exceptions.evidence(
    actor,
    opened.id,
  );
  expect(
    evidence.find((item) => item.adapterVersion === 'stock-following-v1')
      ?.facts,
  ).toMatchObject({ authorityId: jtl, storefrontId: shopify, lagging: 1 });
  expect(
    evidence.filter((item) => item.source).map((item) => item.source.provider),
  ).toEqual(expect.arrayContaining(['jtl', 'shopify']));
  // The product's own gap waits for the stalled sync instead of opening a second case.
  await pass();
  expect(await cases('inventory_mismatch')).toEqual([]);
  expect(
    (await f.call('runs/operations/incidents')).find(
      (item) => item.id === incidentId,
    ),
  ).toMatchObject({ detection: { state: 'detected', caseId: opened.id } });

  // A failed reread from the shop can't close the case.
  await f.call('runs/operations/control', {
    action: 'service-health',
    instance: 'shopify',
    status: 'unavailable',
  });
  await followed(opened.id);
  await f.pilot.detect();
  expect(
    (await f.pilot.detection.exceptions.get(actor, opened.id)).state,
  ).not.toBe('resolved');
  await f.call('runs/operations/control', {
    action: 'service-health',
    instance: 'shopify',
    status: 'healthy',
  });
  // Only the outage's reads failed; later passes must not log errors.
  expect(
    f.pilot.detectionErrors.every((item) =>
      item.error.includes('Inventory read failed'),
    ),
  ).toBe(true);
  f.pilot.detectionErrors.length = 0;

  // The sync runs again: fresh reads of both systems agree, and the case closes verified.
  await f.call(`runs/operations/incidents/${incidentId}/recover`, {});
  const closed = await until(async () => {
    await pass();
    const current = await f.pilot.detection.exceptions.get(actor, opened.id);

    return current.state === 'resolved' && current;
  }, 'verified closure');
  expect(closed.resolution).toMatchObject({
    kind: 'verification',
    outcome: 'passed',
    authoritative: true,
  });
  expect(
    closed.resolution.evidence.every(
      (item) => !evidence.some((source) => source.key === item.key),
    ),
  ).toBe(true);

  // The next unfollowed change is a new case linked to the closed one.
  await restock(250);
  const recurrence = await until(async () => {
    await pass();

    return (await cases('stock_sync_stall')).find(
      (incident) => incident.state !== 'resolved',
    );
  }, 'the recurring stall case');
  expect(recurrence).toMatchObject({ previousExceptionId: opened.id });
  expect(f.pilot.detectionErrors).toEqual([]);
});
