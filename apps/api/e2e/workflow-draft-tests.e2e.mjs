import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { database, signup, startApi, until } from './helpers.mjs';

/** A draft with a decision, an action and a result check; it compiles without installed adapters. */
const releaseHold = {
  schemaVersion: 2,
  definition: {
    id: 'release-hold',
    name: 'Release held orders',
    intent: 'Change the shipping method of orders that are still on hold.',
    category: 'custom',
  },
  version: '1.0.0',
  applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
  inputs: { method: 'string' },
  context: { kind: 'manual', fields: { held: 'boolean' }, maxAgeSeconds: 300 },
  steps: [
    {
      id: 'still-held',
      kind: 'condition',
      field: 'held',
      equals: true,
      onFalse: 'end',
    },
    {
      id: 'review',
      kind: 'approval',
      forStep: 'switch',
      expiresAfterSeconds: 3600,
    },
    {
      id: 'switch',
      kind: 'capability',
      capability: 'orders.shipping-method.write',
      capabilityVersion: '1',
      targetKind: 'order',
      minimumRisk: 'medium',
      parameters: { method: { source: 'input', field: 'method' } },
      expectedPostcondition: { method: { source: 'input', field: 'method' } },
    },
    {
      id: 'confirm',
      kind: 'verification',
      forStep: 'switch',
      evaluatorVersion: '1',
      maxDurationSeconds: 60,
      fields: { method: 'string' },
    },
    { id: 'done', kind: 'end', outcome: 'Shipping method changed' },
  ],
};

const released = (overrides = {}) => ({
  id: randomUUID(),
  name: 'Held order is released',
  inputs: { method: 'express' },
  evidence: { held: true },
  replies: {
    review: { kind: 'approval', decision: 'approved' },
    switch: { kind: 'capability', result: 'accepted' },
    confirm: {
      kind: 'verification',
      state: 'verified',
      values: { method: 'express' },
    },
  },
  expected: { outcome: 'verified' },
  ...overrides,
});

// Final states from the replenishment simulator matrix in replenishment.e2e.mjs.
const simulatorMatrix = {
  'approval-pending': 'awaiting_decision',
  'approved-verified': 'verified',
  'policy-rejected': 'escalated',
  'stale-inventory': 'escalated',
  'existing-order': 'ended',
  'verification-failed': 'failed_verification',
};

it('tests drafts with example data, keeps saved cases and never reaches connected systems', async (t) => {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const api = await startApi(t, db);
  const owner = await signup(api, 'tests-owner');
  const admin = await signup(api, 'tests-admin');
  const member = await signup(api, 'tests-member');
  const org = (
    await api.request('/v1/organizations', {
      cookie: owner.cookie,
      method: 'POST',
      status: 201,
      body: { name: 'Testing', slug: 'draft-testing', dataRegion: 'EU' },
    })
  ).body;
  for (const [user, role] of [
    [admin, 'admin'],
    [member, 'member'],
  ])
    await api.request(`/v1/organizations/${org.id}/members`, {
      cookie: owner.cookie,
      method: 'POST',
      status: 201,
      body: { userId: user.userId, role },
    });
  const base = `/v1/organizations/${org.id}`;
  const as =
    (user) =>
    (path, options = {}) =>
      api.request(`${base}${path}`, { cookie: user.cookie, ...options });
  const call = as(owner);
  const draft = (
    await call('/workflow-drafts', {
      method: 'POST',
      body: {
        id: randomUUID(),
        mode: 'visual',
        start: { kind: 'content', content: releaseHold },
      },
    })
  ).body;
  const path = `/workflow-drafts/${draft.id}`;
  const finished = (id, user = owner) =>
    until(async () => {
      const run = (await as(user)(`${path}/test-runs/${id}`)).body;

      return run.state !== 'running' && run;
    }, `test run ${id}`);

  // Members can prefill from declared fields; this new workflow has no real runs or scenarios.
  const examples = (await as(member)(`${path}/test-examples`)).body;
  expect(examples).toMatchObject({
    fields: {
      inputs: { method: '' },
      evidence: { held: false },
      replies: {
        review: { kind: 'approval', decision: 'approved' },
        switch: { kind: 'capability', result: 'accepted' },
        confirm: {
          kind: 'verification',
          state: 'verified',
          values: { method: '' },
        },
      },
      expected: null,
    },
    runs: [],
    scenarios: [],
  });

  // An unsaved case runs through the interpreter and explains every step.
  const inline = { id: randomUUID(), revision: 1, case: released() };
  const started = (
    await call(`${path}/test-runs`, { method: 'POST', body: inline })
  ).body;
  expect(started).toMatchObject({
    draftId: draft.id,
    revision: 1,
    caseId: null,
  });
  const run = await finished(started.id);
  expect(run).toMatchObject({
    state: 'completed',
    error: null,
    result: { outcome: 'verified', stoppedAt: 'done', passed: true },
  });
  expect(
    run.result.steps.map((step) => [step.stepId, step.state, step.branch]),
  ).toEqual([
    ['still-held', 'completed', 'continued'],
    ['review', 'completed', 'continued'],
    ['switch', 'completed', 'continued'],
    ['confirm', 'completed', 'continued'],
    ['done', 'completed', 'ended'],
  ]);
  expect(run.result.steps[0].note).toBe(
    'held is yes, so the workflow continued.',
  );
  expect(run.result.steps[2]).toMatchObject({
    inputs: { method: 'express' },
    note: expect.stringContaining('Action Admission would check'),
  });

  // Retrying the same request returns the same run; a different body with that ID conflicts.
  expect(
    (await call(`${path}/test-runs`, { method: 'POST', body: inline })).body,
  ).toEqual(run);
  await call(`${path}/test-runs`, {
    method: 'POST',
    status: 409,
    body: { ...inline, case: { ...inline.case, name: 'Other' } },
  });
  await call(`${path}/test-runs`, {
    method: 'POST',
    status: 409,
    body: { id: randomUUID(), revision: 2, case: released() },
  });
  const unfit = await call(`${path}/test-runs`, {
    method: 'POST',
    status: 409,
    body: { id: randomUUID(), revision: 1, case: released({ inputs: {} }) },
  });
  expect(unfit.body.message).toBe('Enter an example value for “method”.');
  await call(`${path}/test-runs`, {
    method: 'POST',
    status: 400,
    body: { id: randomUUID(), revision: 1 },
  });

  // A pending approval shows where the workflow would wait.
  const paused = await finished(
    (
      await call(`${path}/test-runs`, {
        method: 'POST',
        body: {
          id: randomUUID(),
          revision: 1,
          case: released({
            replies: {
              ...released().replies,
              review: { kind: 'approval', decision: 'pending' },
            },
          }),
        },
      })
    ).body.id,
  );
  expect(paused.result).toMatchObject({
    outcome: 'awaiting_decision',
    stoppedAt: 'review',
    passed: false,
  });
  expect(paused.result.steps.at(-1).branch).toBe('paused');

  // Members read saved cases but cannot change or run them.
  const pending = released({
    name: 'Waits for approval',
    replies: {
      ...released().replies,
      review: { kind: 'approval', decision: 'pending' },
    },
    expected: { outcome: 'awaiting_decision' },
  });
  const happy = released();
  const notHeld = released({
    name: 'Order is not held',
    evidence: { held: false },
    expected: { outcome: 'ended' },
  });
  const save = { revision: 0, cases: [happy, pending, notHeld] };
  await as(member)(`${path}/tests`, { method: 'PUT', status: 403, body: save });
  const saved = (await call(`${path}/tests`, { method: 'PUT', body: save }))
    .body;
  expect(saved).toMatchObject({ draftRevision: 1, revision: 1, blocked: null });
  expect(saved.results.map((result) => result.runId)).toEqual([
    null,
    null,
    null,
  ]);
  expect(
    (await call(`${path}/tests`, { method: 'PUT', body: save })).body,
  ).toEqual(saved);
  await call(`${path}/tests`, {
    method: 'PUT',
    status: 409,
    body: { revision: 0, cases: [happy] },
  });
  expect((await as(member)(`${path}/tests`)).body.cases).toHaveLength(3);
  await as(member)(`${path}/tests/run`, {
    method: 'POST',
    status: 403,
    body: { revision: 1 },
  });
  await as(member)(`${path}/test-runs`, {
    method: 'POST',
    status: 403,
    body: { id: randomUUID(), revision: 1, caseId: happy.id },
  });

  // A saved case can run on its own; running all then skips it.
  const savedRun = await finished(
    (
      await call(`${path}/test-runs`, {
        method: 'POST',
        body: { id: randomUUID(), revision: 1, caseId: happy.id },
      })
    ).body.id,
  );
  expect(savedRun).toMatchObject({ caseId: happy.id, state: 'completed' });
  await call(`${path}/tests/run`, { method: 'POST', body: { revision: 1 } });
  const summary = await until(async () => {
    const current = (await as(member)(`${path}/tests`)).body;

    return (
      current.results.every((result) => result.state === 'completed') && current
    );
  }, 'saved cases');
  expect(
    summary.results.map((result) => [result.passed, result.outcome]),
  ).toEqual([
    [true, 'verified'],
    [true, 'awaiting_decision'],
    [true, 'ended'],
  ]);
  expect(summary.results[0].runId).toBe(savedRun.id);
  const countRuns = async () =>
    (
      await db.owner.query(
        'SELECT count(*)::int AS count FROM workflow_draft_test_runs WHERE tenant_id=$1',
        [org.id],
      )
    ).rows[0].count;
  const before = await countRuns();
  expect(
    (await call(`${path}/tests/run`, { method: 'POST', body: { revision: 1 } }))
      .body.results,
  ).toEqual(summary.results);
  expect(await countRuns()).toBe(before);

  // Saving the draft makes a new revision; saved cases run again on it.
  const changed = (
    await call(path, {
      method: 'PUT',
      body: {
        saveId: randomUUID(),
        revision: 1,
        mode: 'visual',
        content: {
          ...releaseHold,
          steps: releaseHold.steps.map((step) =>
            step.id === 'still-held' ? { ...step, onFalse: 'escalate' } : step,
          ),
        },
      },
    })
  ).body;
  expect(changed.revision).toBe(2);
  expect(
    (await call(`${path}/tests`)).body.results.map((result) => result.runId),
  ).toEqual([null, null, null]);
  await call(`${path}/tests/run`, {
    method: 'POST',
    status: 409,
    body: { revision: 1 },
  });
  await call(`${path}/tests/run`, { method: 'POST', body: { revision: 2 } });
  const rerun = await until(async () => {
    const current = (await call(`${path}/tests`)).body;

    return (
      current.results.every((result) => result.state === 'completed') && current
    );
  }, 'saved cases on revision 2');
  expect(rerun).toMatchObject({ draftRevision: 2 });
  expect(
    rerun.results.map((result) => [result.passed, result.outcome]),
  ).toEqual([
    [true, 'verified'],
    [true, 'awaiting_decision'],
    [false, 'escalated'],
  ]);
  expect(await countRuns()).toBe(before + 3);

  // Cancelling stops a running test; only the person who started it can see or cancel it.
  const running = randomUUID();
  const now = Date.now();
  const inFlight = {
    id: running,
    draftId: draft.id,
    revision: 2,
    caseId: null,
    state: 'running',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    result: null,
    error: null,
    caseDigest: null,
  };
  const insert = (item, expiresAt) =>
    db.owner.query(
      "INSERT INTO workflow_draft_test_runs(tenant_id,id,draft_id,draft_revision,principal_id,request_digest,state,document,created_at,expires_at) VALUES($1,$2,$3,2,$4,'digest','running',$5,$6,$7)",
      [
        org.id,
        item.id,
        draft.id,
        owner.userId,
        item,
        item.createdAt,
        expiresAt,
      ],
    );
  await insert(inFlight, inFlight.expiresAt);
  await as(member)(`${path}/test-runs/${running}/cancel`, {
    method: 'POST',
    status: 403,
    body: {},
  });
  await as(admin)(`${path}/test-runs/${running}`, { status: 404 });
  await as(admin)(`${path}/test-runs/${running}/cancel`, {
    method: 'POST',
    status: 404,
    body: {},
  });
  expect(
    (
      await call(`${path}/test-runs/${running}/cancel`, {
        method: 'POST',
        body: {},
      })
    ).body,
  ).toMatchObject({ id: running, state: 'cancelled', result: null });
  expect(
    (
      await call(`${path}/test-runs/${run.id}/cancel`, {
        method: 'POST',
        body: {},
      })
    ).body,
  ).toEqual(run);
  // A run whose API process stopped reads as failed after its deadline.
  const abandoned = { ...inFlight, id: randomUUID() };
  await insert(abandoned, new Date(now - 1000).toISOString());
  expect((await call(`${path}/test-runs/${abandoned.id}`)).body).toMatchObject({
    state: 'failed',
    error: 'The test run was interrupted. Run it again.',
  });

  // No test reached Action Admission, policy, execution or the workflow runtime.
  for (const table of [
    'action_admission_runs',
    'action_admission_steps',
    'policy_decisions',
    'execution_intents',
    'executed_actions',
    'workflow_trigger_runs',
    'workflow_process_steps',
    'playbook_activations',
  ])
    expect(
      (
        await db.owner.query(
          `SELECT count(*)::int AS count FROM ${table} WHERE tenant_id=$1`,
          [org.id],
        )
      ).rows[0].count,
      table,
    ).toBe(0);

  // A customized replenishment copy offers the simulator scenarios with the same outcomes.
  const copy = (
    await call('/workflow-drafts', {
      method: 'POST',
      body: {
        id: randomUUID(),
        mode: 'template',
        start: { kind: 'template', templateId: 'inventory-replenishment' },
      },
    })
  ).body;
  const scenarios = (await call(`/workflow-drafts/${copy.id}/test-examples`))
    .body.scenarios;
  expect(scenarios.map((scenario) => scenario.id).sort()).toEqual(
    Object.keys(simulatorMatrix).sort(),
  );
  for (const scenario of scenarios) {
    const result = await until(async () => {
      const response = await fetch(
        `${api.origin}${base}/workflow-drafts/${copy.id}/test-runs`,
        {
          method: 'POST',
          headers: {
            origin: 'http://localhost:3000',
            cookie: owner.cookie,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            id: randomUUID(),
            revision: copy.revision,
            case: scenario.case,
          }),
        },
      );

      // The runner accepts two runs at a time; retry when it is busy.
      return response.status === 200 && response.json();
    }, `scenario ${scenario.id}`);
    const done = await until(async () => {
      const current = (
        await call(`/workflow-drafts/${copy.id}/test-runs/${result.id}`)
      ).body;

      return current.state !== 'running' && current;
    }, `scenario run ${scenario.id}`);
    expect([scenario.id, done.result.outcome, done.result.passed]).toEqual([
      scenario.id,
      simulatorMatrix[scenario.id],
      true,
    ]);
  }

  // Other workspaces cannot see saved cases or runs, including under RLS.
  const outsider = await signup(api, 'tests-outsider');
  await api.request(`${base}${path}/tests`, {
    cookie: outsider.cookie,
    status: 404,
  });
  const other = (
    await api.request('/v1/organizations', {
      cookie: outsider.cookie,
      method: 'POST',
      status: 201,
      body: { name: 'Other', slug: 'other-testing', dataRegion: 'EU' },
    })
  ).body;
  const otherBase = `/v1/organizations/${other.id}${path}`;
  await api.request(`${otherBase}/tests`, {
    cookie: outsider.cookie,
    status: 404,
  });
  await api.request(`${otherBase}/test-runs/${run.id}`, {
    cookie: outsider.cookie,
    status: 404,
  });
  await api.request(`${otherBase}/test-runs`, {
    cookie: outsider.cookie,
    method: 'POST',
    status: 404,
    body: { id: randomUUID(), revision: 2, case: released() },
  });
  const runtime = new Pool({ connectionString: db.runtimeUrl });
  t.onTestFinished(() => runtime.end());
  const tx = await runtime.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT set_config('app.tenant_id',$1,true)", [other.id]);
    expect(
      (await tx.query('SELECT draft_id FROM workflow_draft_tests')).rows,
    ).toEqual([]);
    expect(
      (await tx.query('SELECT id FROM workflow_draft_test_runs')).rows,
    ).toEqual([]);
    await expect(
      tx.query(
        "INSERT INTO workflow_draft_tests(tenant_id,draft_id,revision,cases,updated_by,updated_at) VALUES($1,$2,1,'[]',$3,now())",
        [org.id, copy.id, outsider.userId],
      ),
    ).rejects.toThrow();
    await tx.query('ROLLBACK');
  } finally {
    tx.release();
  }
}, 120_000);
