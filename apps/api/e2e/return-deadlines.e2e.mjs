import { randomUUID } from 'node:crypto';

import { expect, it, vi } from 'vitest';

import { caseWorkflowFixture } from './case-workflows-fixture.mjs';
import { settlementFixture } from './return-settlement-fixture.mjs';

const policy = () => ({
  commandId: randomUUID(),
  expectedRevision: 0,
  enabled: true,
  receiptHours: 1,
  inspectionHours: 1,
  financialHours: 1,
  sourceMaxAgeSeconds: 300,
});

it('anchors owned overdue waits to actual partial receipt and inspection, deduplicates checks and retains policy history', async (t) => {
  const environment = await caseWorkflowFixture(t, { timeSkipping: true });
  const f = await settlementFixture(t, { prepare: 'opened', environment });
  const input = policy();
  await f.request('/return-deadlines', input);
  expect((await f.request('/return-deadlines', input)).policy.revision).toBe(1);
  await f.request(
    '/return-deadlines',
    { ...input, receiptHours: 2 },
    f.requester,
    409,
  );
  const first = await f.request(`${f.path}/waiting/check`, {});
  expect(first.episodes).toHaveLength(1);
  expect(first.episodes[0]).toMatchObject({
    reason: 'missing_units',
    state: 'waiting',
    units: 2,
    anchorAt: f.detail.case.openedAt,
    ownerId: f.manifest.operatorId,
  });
  await environment.activate('return-case-follow-up');
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    await environment.temporal.sleep(2 * 3_600_000);
    vi.setSystemTime(await environment.temporal.currentTimeMs());
    await environment.tick();
    const overdue = await f.request(`${f.path}/waiting`);
    await expect
      .poll(
        async () =>
          (await environment.runs('return-case-follow-up'))[0]?.processState,
        { timeout: 15_000 },
      )
      .toBe('escalated');
    await environment.tick();
    expect(await environment.runs('return-case-follow-up')).toHaveLength(1);
    await environment.restartWorker();
    await environment.tick();
    expect(await environment.runs('return-case-follow-up')).toHaveLength(1);
    expect(overdue.episodes[0]).toMatchObject({
      id: first.episodes[0].id,
      state: 'escalated',
      occurrence: 1,
    });
    let detail = await f.request(`${f.path}/receipt`, {
      commandId: randomUUID(),
      expectedRevision: f.detail.case.revision,
      lines: f.lines.map((l) => ({ orderLineId: l.orderLineId, received: 1 })),
      evidence: f.evidence,
    });
    const partial = await f.request(`${f.path}/waiting/check`, {});
    expect(partial.episodes).toHaveLength(2);
    expect(partial.episodes.find((e) => e.phase === 'receipt')).toMatchObject({
      id: first.episodes[0].id,
      units: 1,
      state: 'escalated',
    });
    expect(
      partial.episodes.find((e) => e.phase === 'inspection'),
    ).toMatchObject({
      anchorAt: detail.receipt.at,
      anchorOrigin: 'receipt_recorded',
      state: 'waiting',
      units: 1,
    });
    detail = await f.request(`${f.path}/inspection`, {
      commandId: randomUUID(),
      expectedRevision: detail.case.revision,
      lines: f.lines.map((l) => ({
        orderLineId: l.orderLineId,
        resellable: 1,
        damaged: 0,
      })),
      evidence: f.evidence,
    });
    const inspected = await f.request(`${f.path}/waiting/check`, {});
    expect(
      inspected.episodes.find((e) => e.phase === 'inspection'),
    ).toMatchObject({ state: 'verified' });
    expect(
      inspected.episodes.find((e) => e.phase === 'proposal'),
    ).toMatchObject({ anchorAt: detail.inspection.at, state: 'waiting' });
    const disabled = await f.request('/return-deadlines', {
      ...input,
      commandId: randomUUID(),
      expectedRevision: 1,
      enabled: false,
    });
    expect(disabled.policy.revision).toBe(2);
    const paused = await f.request(`${f.path}/waiting/check`, {});
    expect(paused.episodes.filter((e) => e.state === 'paused')).toHaveLength(2);
    await f.request('/return-deadlines', {
      ...input,
      commandId: randomUUID(),
      expectedRevision: 2,
    });
    const resumed = await f.request(`${f.path}/waiting/check`, {});
    expect(resumed.episodes.filter((e) => e.policyRevision === 3)).toHaveLength(
      2,
    );
    expect(
      (await f.request(`${f.path}/waiting/check`, {})).episodes,
    ).toHaveLength(resumed.episodes.length);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps native pending refunds overdue, verifies late actual payment and preserves a new owned evidence outage without another refund', async (t) => {
  const f = await settlementFixture(t);
  await f.request('/return-deadlines', policy());
  const refund = await f.request(`${f.path}/settlements`, {
    id: randomUUID(),
    kind: 'refund',
  });
  await f.request(
    `${f.path}/settlements/${refund.id}/decision`,
    { decisionId: refund.decisionId, outcome: 'approved' },
    f.approver,
  );
  const first = await f.request(`${f.path}/waiting/check`, {});
  expect(first.episodes[0]).toMatchObject({
    phase: 'financial',
    reason: 'pending_money',
    state: 'waiting',
    anchorAt: refund.requestedAt,
  });
  const at = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(at + 2 * 3_600_000);
    expect(
      (await f.request(`${f.path}/waiting/check`, {})).episodes[0],
    ).toMatchObject({
      id: first.episodes[0].id,
      state: 'escalated',
      reason: 'pending_money',
    });
    await f.command({ kind: 'refund-settle', order: f.providerOrderId });
    const paid = await f.request(`${f.path}/waiting/check`, {});
    expect(paid.episodes[0]).toMatchObject({
      state: 'verified',
      occurrence: 1,
    });
    expect(paid.episodes[0].observedAt).toBe(new Date().toISOString());
    const members = await f.request('/members', undefined, f.approver);
    const membership = members.items.find(
      (m) => m.userId === f.manifest.operatorId,
    );
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: `${f.root}/roles`,
      headers: {
        cookie: f.approver,
        origin: 'http://127.0.0.1:3000',
        'x-command-id': randomUUID(),
      },
      payload: {
        name: 'Return manager without source access',
        description: '',
        permissions: ['returns.read', 'returns.manage'],
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const changed = await f.pilot.app.inject({
      method: 'PATCH',
      url: `${f.root}/members/${membership.id}`,
      headers: { cookie: f.approver, origin: 'http://127.0.0.1:3000' },
      payload: { roleId: response.json().id },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    await f.call('runs/operations/control', {
      action: 'fault',
      rule: {
        instance: 'shopify',
        operation: 'returns.settlement.proof.read',
        kind: 'malformed',
        remaining: 2,
      },
    });
    const outage = await f.request(`${f.path}/waiting/check`, {});
    const latest = outage.episodes.find((e) => e.state === 'escalated');
    expect(latest).toMatchObject({
      phase: 'financial',
      reason: 'unavailable_evidence',
      occurrence: 2,
      ownerId: f.manifest.operatorId,
    });
    expect(
      outage.episodes.find((e) => e.id === first.episodes[0].id).state,
    ).toBe('verified');
    expect(
      (await f.request(`${f.path}/waiting/check`, {})).episodes,
    ).toHaveLength(2);
    const restored = await f.pilot.app.inject({
      method: 'PATCH',
      url: `${f.root}/members/${membership.id}`,
      headers: { cookie: f.approver, origin: 'http://127.0.0.1:3000' },
      payload: { roleId: membership.role.id },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const recovered = await f.request(`${f.path}/waiting/check`, {});
    expect(recovered.episodes.every((e) => e.state === 'verified')).toBe(true);
    const reader = await f.pilot.app.inject({
      method: 'POST',
      url: `${f.root}/roles`,
      headers: {
        cookie: f.approver,
        origin: 'http://127.0.0.1:3000',
        'x-command-id': randomUUID(),
      },
      payload: {
        name: 'Read-only returns',
        description: '',
        permissions: ['returns.read'],
      },
    });
    expect(reader.statusCode, reader.body).toBe(201);
    const restricted = await f.pilot.app.inject({
      method: 'PATCH',
      url: `${f.root}/members/${membership.id}`,
      headers: { cookie: f.approver, origin: 'http://127.0.0.1:3000' },
      payload: { roleId: reader.json().id },
    });
    expect(restricted.statusCode, restricted.body).toBe(200);
    expect((await f.request(`${f.path}/waiting`)).canManage).toBe(false);
    await f.request(`${f.path}/waiting/check`, {}, f.requester, 403);
    await f.request(
      '/return-deadlines',
      { ...policy(), expectedRevision: 1 },
      f.requester,
      403,
    );
    const other = await f.pilot.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: f.approver, origin: 'http://127.0.0.1:3000' },
      payload: {
        name: 'Deadline isolation',
        slug: `deadlines-${randomUUID()}`,
        dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
      },
    });
    expect(other.statusCode, other.body).toBe(201);
    const hidden = await f.pilot.app.inject({
      method: 'GET',
      url: `/v1/organizations/${other.json().id}${f.path}/waiting`,
      headers: { cookie: f.approver },
    });
    expect(hidden.statusCode, hidden.body).toBe(404);
    const count = (
      await f.call('runs/operations/records/shopify?kind=Refund&limit=100')
    ).items.filter((r) => r.data.order === f.providerOrderId).length;
    expect(count).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
