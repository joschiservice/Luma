import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';
import { expect, it } from 'vitest';

import { seedResolutionMeasurement } from './resolution-measurement-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

it('reconciles detection and verification intervals, exact filters, paging and tenant boundaries', async (t) => {
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'resolution-insights': true },
  });
  const f = await settingsFixture(t, 'http://localhost:3000', {
    observability,
  });
  const end = new Date().toISOString(),
    start = new Date(Date.now() - 7 * 86400000).toISOString();
  const connectionId = randomUUID();
  const a = await seedResolutionMeasurement(f, {
    sourceConnectionId: connectionId,
  });
  const late = await seedResolutionMeasurement(f, {
    sourceConnectionId: connectionId,
    detectedAt: new Date(Date.now() - 20 * 86400000).toISOString(),
    previousIncidentId: a.id,
  });
  const pending = await seedResolutionMeasurement(f, {
    sourceConnectionId: connectionId,
    verified: false,
  });
  await seedResolutionMeasurement(f, { synthetic: true });
  const endpoint = `/v2/organizations/${f.org.id}/metrics/query`;
  const request = {
    definitionVersion: 2,
    metrics: [
      'resolution.detected',
      'resolution.completed',
      'resolution.eligible',
      'resolution.autonomous',
      'resolution.pending',
      'resolution.completion_time',
    ],
    scope: {
      start,
      end,
      environment: 'live',
      issueClass: 'inventory_mismatch',
      connectionId,
    },
    limit: 1,
  };
  const result = await f.request(f.member, endpoint, 'POST', request);
  const metric = (id) =>
    result.metrics.find((m) => m.definition.id === `resolution.${id}`);
  expect(metric('detected')).toMatchObject({ value: 2, population: 2 });
  expect(metric('completed')).toMatchObject({
    value: 2,
    population: 2,
    dataThrough: null,
  });
  expect(metric('eligible').value).toBe(2);
  const offset = (instant) =>
    new Date(Date.parse(instant) + 9 * 3600000)
      .toISOString()
      .replace('Z', '+09:00');
  const sameWindow = await f.request(f.member, endpoint, 'POST', {
    ...request,
    scope: { ...request.scope, start: offset(start), end: offset(end) },
  });
  expect(sameWindow.metrics.map((metric) => metric.value)).toEqual(
    result.metrics.map((metric) => metric.value),
  );
  expect(metric('pending').items.map((i) => i.id)).toEqual([pending.id]);
  const cursor = metric('completed').nextCursor;
  const second = await f.request(f.member, endpoint, 'POST', {
    ...request,
    cursor,
  });
  const completed = second.metrics.find(
    (m) => m.definition.id === 'resolution.completed',
  );
  expect(
    new Set(
      [...metric('completed').items, ...completed.items].map((i) => i.id),
    ),
  ).toEqual(new Set([a.id, late.id]));
  await f.request(
    f.member,
    endpoint,
    'POST',
    {
      ...request,
      cursor,
      scope: { ...request.scope, issueClass: 'sync_failure' },
    },
    422,
  );
  await f.request(f.outsider, endpoint, 'POST', request, 404);
  await f.request(null, endpoint, 'POST', request, 401);
  await late.record({
    kind: 'eligibility',
    status: 'ineligible',
    ruleVersion: 'review/2',
    reasonCode: 'outside_scope',
  });
  await f.request(f.member, endpoint, 'POST', { ...request, cursor }, 409);
  await f.request(
    f.member,
    endpoint,
    'POST',
    {
      ...request,
      scope: { start, end: new Date(Date.now() + 86400000).toISOString() },
    },
    422,
  );
  const created = await f.app.inject({
    method: 'POST',
    url: `${f.base}/roles`,
    headers: {
      origin: f.config.baseURL,
      cookie: f.owner.cookie,
      'x-command-id': randomUUID(),
    },
    payload: {
      name: 'Recorded issues only',
      description: '',
      permissions: ['issues.read'],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  await f.request(f.owner, `${f.base}/members/${f.membership.id}`, 'PATCH', {
    roleId: created.json().id,
  });
  await f.request(
    f.member,
    endpoint,
    'POST',
    {
      ...request,
      scope: {
        ...request.scope,
        artifactId: 'private-workflow',
        artifactVersion: '1',
      },
    },
    403,
  );
});

it('keeps resolution reporting off until released and leaves existing measurements available', async (t) => {
  const f = await settingsFixture(t);
  const endpoint = `/v2/organizations/${f.org.id}/metrics/query`;
  await f.request(
    f.owner,
    endpoint,
    'POST',
    {
      definitionVersion: 2,
      metrics: ['resolution.completed'],
      scope: { window: '30d' },
    },
    503,
  );
  const registry = await f.request(
    f.owner,
    `/v2/organizations/${f.org.id}/metrics`,
  );
  expect(
    registry.some((definition) => definition.id === 'resolution.completed'),
  ).toBe(false);
  const result = await f.request(f.owner, endpoint, 'POST', {
    definitionVersion: 2,
    metrics: ['resolution.verified'],
    scope: { window: '7d' },
  });
  expect(result.metrics[0].value).toBe(0);
});
