import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { until } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

test('inventory drift is detected, verified, scored and recurs through the same HTTP APIs as the panel', async (t) => {
  const f = await setupSimulator(t);
  const check = () => f.call('runs/operations/operations/check', {});
  const status = () => f.call('runs/operations/operations');
  const inject = (id) =>
    f.call('runs/operations/incidents', {
      id,
      kind: 'inventory-drift',
      target: 'LUMA-SCENARIO-001',
    });
  const recover = (id) => f.call(`runs/operations/incidents/${id}/recover`, {});
  expect(await check()).toMatchObject({
    connected: true,
    incident: null,
    lastCheck: { outcome: 'clear' },
  });
  const id = randomUUID();
  const injected = await inject(id);
  expect(injected).toMatchObject({ id, status: 'active', origin: 'injected' });
  expect((await inject(id)).id).toBe(id);
  const detected = await check();
  expect(detected.lastCheck, JSON.stringify(detected)).toMatchObject({
    outcome: 'detect',
  });
  expect(detected.incident).toMatchObject({
    occurrenceCount: 1,
    previousExceptionId: null,
  });
  const firstId = detected.incident.id;
  const actor = await f.pilot.operator();
  const sources = await f.pilot.detection.exceptions.evidence(actor, firstId);
  expect(sources).toHaveLength(3);
  expect((await check()).incident).toMatchObject({
    id: firstId,
    occurrenceCount: 2,
  });
  const scored = await f.call('runs/operations/scorecard');
  expect(scored.luma).toEqual({ connected: true, error: null });
  expect(
    scored.byKind.find((row) => row.kind === 'inventory-drift'),
  ).toMatchObject({
    total: 1,
    detected: 1,
  });
  const view = (await f.call('runs/operations/incidents')).find(
    (incident) => incident.id === id,
  );
  expect(view.detection).toMatchObject({ state: 'detected', caseId: firstId });
  await recover(id);
  expect((await status()).incident.state).not.toBe('resolved');
  await f.call('runs/operations/control', {
    action: 'service-health',
    instance: 'shopify',
    status: 'unavailable',
  });
  expect((await check()).lastCheck.outcome).toBe('unavailable');
  expect((await status()).incident.state).not.toBe('resolved');
  await f.call('runs/operations/control', {
    action: 'service-health',
    instance: 'shopify',
    status: 'healthy',
  });
  const recovered = await check();
  expect(recovered.lastCheck, JSON.stringify(recovered)).toMatchObject({
    outcome: 'clear',
  });
  expect(recovered.incident).toMatchObject({ id: firstId, state: 'resolved' });
  const resolved = await f.pilot.detection.exceptions.get(actor, firstId);
  expect(resolved.resolution).toMatchObject({
    kind: 'verification',
    outcome: 'passed',
    authoritative: true,
    complete: true,
  });
  expect(
    resolved.resolution.evidence.every(
      (item) => !sources.some((source) => source.key === item.key),
    ),
  ).toBe(true);
  const next = randomUUID();
  await inject(next);
  const recurrence = await check();
  expect(recurrence.incident).toMatchObject({
    previousExceptionId: firstId,
    occurrenceCount: 1,
  });
  // An old recovery request leaves the new occurrence intact.
  await recover(id);
  expect((await check()).lastCheck.outcome).toBe('detect');
  await recover(next);
  expect((await check()).incident).toMatchObject({
    id: recurrence.incident.id,
    state: 'resolved',
  });
  await f.call('runs/operations/control', { action: 'reset' });
  await f.ready();
  expect((await check()).lastCheck.outcome).toBe('clear');
  const unauthenticated = await fetch(
    `${f.apiOrigin}/v1/organizations/${f.manifest.organizationId}/simulator/inventory`,
  );
  expect(unauthenticated.status).toBe(401);
});

test('scheduled detection compares linked stock and closes the case only after fresh verification', async (t) => {
  const f = await setupSimulator(t);
  const actor = await f.pilot.operator();
  const stockCases = async () =>
    (await f.pilot.detection.exceptions.list(actor)).filter(
      (incident) =>
        incident.exceptionClass === 'inventory_mismatch' &&
        incident.subject.scope.includes(f.manifest.connections.shopify) &&
        !f.pilot.inventoryScenario?.matches(incident),
    );
  await f.pilot.observe({ check: false });
  expect(await f.pilot.link()).toEqual({ linked: 1, remaining: 0 });
  await f.pilot.detect();
  expect(await stockCases()).toEqual([]);

  const id = randomUUID();
  await f.call('runs/operations/incidents', {
    id,
    kind: 'inventory-drift',
    target: 'LUMA-001',
  });
  await f.pilot.observe({ check: false });
  // A small gap waits for provider sync first; the journey's window is one second.
  const opened = await until(async () => {
    await f.pilot.detect();

    return (await stockCases())[0];
  }, 'the stock gap outlasts the sync window');
  expect(opened).toMatchObject({
    state: expect.not.stringMatching('resolved'),
  });
  expect(opened.subject.scope.slice(1)).toEqual(
    [f.manifest.connections.jtl, f.manifest.connections.shopify].sort(),
  );
  const evidence = await f.pilot.detection.exceptions.evidence(
    actor,
    opened.id,
  );
  // Both reads, the mapping and the agreement history the wait was based on.
  expect(evidence.map((item) => item.source?.provider).sort()).toEqual([
    'jtl',
    'shopify',
    undefined,
    undefined,
  ]);

  // The shop is wrong until the merchant repairs it; another pass keeps the case open.
  await f.pilot.detect();
  expect((await stockCases())[0]).toMatchObject({
    id: opened.id,
    state: expect.not.stringMatching('resolved'),
  });
  await f.call(`runs/operations/incidents/${id}/recover`, {});
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  const closed = await f.pilot.detection.exceptions.get(actor, opened.id);
  expect(closed.state).toBe('resolved');
  expect(closed.resolution).toMatchObject({
    kind: 'verification',
    outcome: 'passed',
  });
  expect(
    (await f.call('runs/operations/incidents')).find((item) => item.id === id),
  ).toMatchObject({ detection: { state: 'detected', caseId: opened.id } });
  expect(f.pilot.detectionErrors).toEqual([]);
});

test('sustained malformed shop responses escalate after retries and close only after a complete scan', async (t) => {
  const f = await setupSimulator(t);
  const actor = await f.pilot.operator();
  const syncCases = async () =>
    (await f.pilot.detection.exceptions.list(actor)).filter(
      (incident) => incident.exceptionClass === 'sync_failure',
    );
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(await syncCases()).toEqual([]);

  // One unreadable response stays in automatic retry handling.
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
  await f.pilot.detect();
  expect(await syncCases()).toEqual([]);
  for (let attempt = 1; attempt < 5; attempt++)
    await f.pilot.observe({ check: false });
  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET failing_since=now()-interval '16 minutes'
     WHERE tenant_id=$1 AND connection_id=$2 AND error_code IS NOT NULL`,
    [f.manifest.organizationId, f.manifest.connections.shopify],
  );
  await f.pilot.detect();
  const [opened, ...others] = await syncCases();
  expect(others).toEqual([]);
  expect(opened).toMatchObject({
    severity: 'medium',
    subject: {
      subjectId: f.manifest.connections.shopify,
      scope: ['products.read'],
    },
  });
  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET failing_since=now()-interval '61 minutes'
     WHERE tenant_id=$1 AND connection_id=$2 AND error_code IS NOT NULL`,
    [f.manifest.organizationId, f.manifest.connections.shopify],
  );
  await f.pilot.detect();
  expect((await syncCases())[0]).toMatchObject({
    id: opened.id,
    severity: 'high',
  });

  // Recovery alone does not close the case; a complete scan after detection does.
  const [fault] = (await f.call('runs/operations')).faults;
  await f.call('runs/operations/control', { action: 'disable', id: fault.id });
  await f.pilot.detect();
  expect((await syncCases())[0].state).not.toBe('resolved');
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(
    await f.pilot.detection.exceptions.get(actor, opened.id),
  ).toMatchObject({
    state: 'resolved',
    resolution: { kind: 'verification', outcome: 'passed' },
  });
  expect(f.pilot.detectionErrors).toEqual([]);
});
