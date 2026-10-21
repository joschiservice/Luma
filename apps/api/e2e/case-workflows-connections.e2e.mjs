import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { caseWorkflowFixture } from './case-workflows-fixture.mjs';
import { until } from './helpers.mjs';

test('a connection check ends without handing over when reads have already recovered', async (t) => {
  const f = await caseWorkflowFixture(t);
  const check = 'connection-sync-check';
  await f.activate(check);
  await f.pilot.observe({ check: false });
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'shopify',
      operation: 'products.read',
      kind: 'malformed',
      remaining: 100,
    },
  });
  await f.pilot.observe({ check: false });
  // Start from a sustained failure whose automatic retries have been exhausted.
  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET attempts=5,failing_since=now()-interval '16 minutes'
     WHERE tenant_id=$1 AND connection_id=$2 AND error_code IS NOT NULL`,
    [f.manifest.organizationId, f.manifest.connections.shopify],
  );
  await f.pilot.detect();
  const [opened] = (await f.pilot.detection.exceptions.list(f.actor)).filter(
    (item) => item.exceptionClass === 'sync_failure',
  );
  expect(opened).toBeDefined();
  expect(opened.severity).toBe('medium');
  // The provider recovers before the run reads the stream.
  const [fault] = (await f.call('runs/operations')).faults;
  await f.call('runs/operations/control', { action: 'disable', id: fault.id });
  await f.pilot.observe({ check: false });
  await f.tick();
  const [run] = await f.runs(check);
  const ended = await f.waitFor(check, run.id, 'ended');
  expect(
    ended.processSteps.find((step) => step.stepId === 'failure').values,
  ).toMatchObject({ ready: true, failing: false, accessLost: false });
  expect(
    (await f.request(`/workflows/${check}`)).summary.readiness.approval.mode,
  ).toBe('no_actions');
});

test('lost store access opens a case for a person, and reconnecting closes it after a fresh scan', async (t) => {
  const f = await caseWorkflowFixture(t);
  const check = 'connection-sync-check';
  const shop = f.manifest.connections.shopify;
  await f.activate(check);
  await f.pilot.observe({ check: false });
  const [incident] = await f.call('runs/operations/scenarios', {
    id: randomUUID(),
    scenario: 'access-revoked',
  });
  await f.pilot.observe({ check: false });
  const connection = async (id) =>
    (await f.request('/connections')).items.find((item) => item.id === id);
  expect((await connection(shop)).status).toBe('revoked');

  await f.pilot.detect();
  await f.pilot.detect();
  const lost = (await f.pilot.detection.exceptions.list(f.actor)).filter(
    (item) =>
      item.exceptionClass === 'sync_failure' && item.state !== 'resolved',
  );
  expect(lost, JSON.stringify(f.pilot.detectionErrors)).toEqual([
    expect.objectContaining({
      severity: 'high',
      subject: expect.objectContaining({ subjectId: shop }),
    }),
  ]);
  await f.tick();
  const [run] = await f.runs(check);
  const handed = await f.waitFor(check, run.id, 'escalated');
  expect(
    handed.processSteps.find((step) => step.stepId === 'failure').values,
  ).toMatchObject({ ready: true, accessLost: true });
  await until(
    async () =>
      (await f.call('runs/operations/incidents')).find(
        (item) => item.id === incident.id,
      )?.detection?.state === 'detected',
    'scorecard reports the incident as detected',
    15_000,
  );

  // The provider accepts Luma again, but the case waits for a person to reconnect.
  await f.call(`runs/operations/incidents/${incident.id}/recover`, {});
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(
    (await f.pilot.detection.exceptions.list(f.actor)).find(
      (item) => item.id === lost[0].id,
    ).state,
  ).not.toBe('resolved');
  const revoked = await connection(shop);
  const pending = await f.request(`/connections/${shop}/credentials`, {
    version: revoked.version,
    credentials: { token: 'reconnected-token' },
  });
  expect(pending).toMatchObject({ id: shop, status: 'pending' });
  expect(
    await f.request(`/connections/${shop}/check`, {
      version: pending.version,
    }),
  ).toMatchObject({ status: 'active' });
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(
    (await f.pilot.detection.exceptions.list(f.actor)).find(
      (item) => item.id === lost[0].id,
    ).state,
  ).toBe('resolved');

  // A connection a person disconnects raises nothing.
  const jtl = await connection(f.manifest.connections.jtl);
  await f.request(`/connections/${jtl.id}/disconnect`, {
    version: jtl.version,
  });
  await f.pilot.detect();
  expect(
    (await f.pilot.detection.exceptions.list(f.actor)).filter(
      (item) =>
        item.exceptionClass === 'sync_failure' && item.state !== 'resolved',
    ),
  ).toEqual([]);
});
