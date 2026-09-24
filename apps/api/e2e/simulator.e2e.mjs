import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { setupSimulator } from './simulator-fixture.mjs';

test('inventory scenario detects, verifies and recurs through the same HTTP APIs used by the panel', async (t) => {
  const f = await setupSimulator(t);
  const check = () => f.call('runs/operations/operations/check', {});
  const status = () => f.call('runs/operations/operations');
  const id = randomUUID();
  expect(await check()).toMatchObject({
    connected: true,
    incident: null,
    lastCheck: { outcome: 'clear' },
  });
  const injected = await f.call('runs/operations/scenarios', {
    id,
    kind: 'inventory-mismatch',
  });
  expect(
    await f.call('runs/operations/scenarios', {
      id,
      kind: 'inventory-mismatch',
    }),
  ).toEqual(injected);
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'jtl',
    command: { kind: 'order', id: '100', quantity: 5 },
  });
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
  expect(sources.map((item) => item.adapterVersion).sort()).toEqual([
    'canonical-mapping-v1',
    'jtl/0',
    'shopify/0',
  ]);
  expect((await check()).incident).toMatchObject({
    id: firstId,
    occurrenceCount: 2,
  });
  await f.call('runs/operations/scenarios/' + id + '/recover', {});
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
  expect(resolved.resolution.evidence).toHaveLength(2);
  expect(
    resolved.resolution.evidence.every(
      (item) => !sources.some((source) => source.key === item.key),
    ),
  ).toBe(true);
  expect(
    resolved.resolution.bindings.every(
      (item) => item.postcondition === 'equivalent_inventory_agrees',
    ),
  ).toBe(true);
  const next = randomUUID();
  await f.call('runs/operations/scenarios', {
    id: next,
    kind: 'inventory-mismatch',
  });
  const recurrence = await check();
  expect(recurrence.incident).toMatchObject({
    previousExceptionId: firstId,
    occurrenceCount: 1,
  });
  expect(recurrence.incident.id).not.toBe(firstId);
  await f.call('runs/operations/scenarios/' + id + '/recover', {});
  expect((await check()).lastCheck.outcome).toBe('detect');
  await f.call('runs', { id: 'unbound', scenario: 'manual' });
  expect(await f.call('runs/unbound/operations/check', {})).toEqual({
    connected: false,
  });
  expect(
    (await f.call('runs')).find((run) => run.id === 'unbound')
      .operationalScenarios,
  ).toEqual([]);
  await f.call('runs/operations/control', { action: 'reset' });
  expect((await check()).incident).toMatchObject({
    id: recurrence.incident.id,
    state: 'resolved',
  });
  const finalScenarioId = randomUUID();
  await f.call('runs/operations/scenarios', {
    id: finalScenarioId,
    kind: 'inventory-mismatch',
  });
  expect((await check()).lastCheck.outcome).toBe('detect');
  for (const quantity of [90, 95])
    await f.call('runs/operations/control', {
      action: 'command',
      instance: 'jtl',
      command: { kind: 'stock', id: '2', quantity },
    });
  expect((await check()).lastCheck.outcome).toBe('detect');
  await f.call(`runs/operations/scenarios/${finalScenarioId}/recover`, {});
  const matched = await check();
  expect(matched.lastCheck, JSON.stringify(matched)).toMatchObject({
    outcome: 'clear',
  });
  expect(matched.incident.state).toBe('resolved');
  await f.call('runs/operations/control', { action: 'reset' });
  expect((await check()).lastCheck.outcome).toBe('clear');
  const unauthenticated = await fetch(
    `${f.apiOrigin}/v1/organizations/${f.manifest.organizationId}/simulator/inventory`,
  );
  expect(unauthenticated.status).toBe(401);
});
