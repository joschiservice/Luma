import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { authoringModel } from './authoring-fixture.mjs';
import { database, signup, startApi } from './helpers.mjs';

/** A computation workflow that validates against the default installed vocabulary. */
const checkOrder = {
  schemaVersion: 2,
  definition: {
    id: 'order-hold-check',
    name: 'Check held orders',
    intent: 'Escalate orders that are still on hold.',
    category: 'custom',
  },
  version: '1.0.0',
  applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
  inputs: {},
  context: { kind: 'manual', fields: { held: 'boolean' }, maxAgeSeconds: 300 },
  steps: [
    {
      id: 'still-held',
      kind: 'condition',
      field: 'held',
      equals: true,
      onFalse: 'end',
    },
    { id: 'hand-over', kind: 'escalation', reason: 'Order is still on hold' },
  ],
};

async function workspace(api, name) {
  const owner = await signup(api, `${name}-owner`);
  const member = await signup(api, `${name}-member`);
  const org = (
    await api.request('/v1/organizations', {
      cookie: owner.cookie,
      method: 'POST',
      status: 201,
      body: {
        name,
        slug: name,
        dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
      },
    })
  ).body;
  await api.request(`/v1/organizations/${org.id}/members`, {
    cookie: owner.cookie,
    method: 'POST',
    status: 201,
    body: { userId: member.userId, roleId: 'member' },
  });

  return { org, owner, member, base: `/v1/organizations/${org.id}` };
}

it('explains why describing is unavailable without a regional route and keeps tenants apart', async (t) => {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const api = await startApi(t, db);
  const { owner, member, base } = await workspace(api, 'describing');
  const other = await workspace(api, 'elsewhere');
  const call = (user, path, options = {}) =>
    api.request(`${base}${path}`, { cookie: user.cookie, ...options });

  const availability = (await call(member, '/workflow-authoring/generation'))
    .body;
  expect(availability).toEqual({
    available: false,
    improvements: false,
    improvementDiscovery: false,
    reason: expect.stringMatching(
      /^Describing workflows needs a regional model route with zero data retention\. Whoever runs this Luma server/,
    ),
  });

  const draftId = randomUUID();
  const describe = { id: randomUUID(), draftId, prompt: 'Reorder low stock.' };
  await call(member, '/workflow-authoring/describe', {
    method: 'POST',
    status: 403,
    body: describe,
  });
  const unavailable = await call(owner, '/workflow-authoring/describe', {
    method: 'POST',
    status: 503,
    body: describe,
  });
  expect(unavailable.body).toEqual(
    expect.objectContaining({
      code: 'SERVICE_UNAVAILABLE',
      message: availability.reason,
    }),
  );
  await call(owner, `/workflow-drafts/${draftId}`, { status: 404 });

  const draft = (
    await call(owner, '/workflow-drafts', {
      method: 'POST',
      body: {
        id: randomUUID(),
        mode: 'visual',
        start: { kind: 'content', content: checkOrder },
      },
    })
  ).body;
  const refine = { id: randomUUID(), revision: 1, instruction: 'Wait first.' };
  const suggestion = {
    id: randomUUID(),
    revision: 1,
    stepId: null,
    description: 'Count the held days.',
  };
  for (const [path, body] of [
    ['proposals', refine],
    ['code-step-suggestions', suggestion],
    [`proposals/${randomUUID()}/accept`, { revision: 1, saveId: randomUUID() }],
    [`proposals/${randomUUID()}/reject`, {}],
  ])
    await call(member, `/workflow-drafts/${draft.id}/${path}`, {
      method: 'POST',
      status: 403,
      body,
    });
  expect(
    (
      await call(owner, `/workflow-drafts/${draft.id}/proposals`, {
        method: 'POST',
        status: 503,
        body: refine,
      })
    ).body.message,
  ).toBe(availability.reason);
  expect(
    (await call(owner, `/workflow-drafts/${draft.id}`)).body.revision,
  ).toBe(1);
  expect(
    (await call(member, `/workflow-drafts/${draft.id}/generations`)).body,
  ).toEqual({ items: [] });

  // Another workspace can't reach this draft's proposals or provenance.
  const foreign = (path, options = {}) =>
    api.request(`${other.base}/workflow-drafts/${draft.id}${path}`, {
      cookie: other.owner.cookie,
      ...options,
    });
  await foreign('/generations', { status: 404 });
  await foreign('/proposals', { method: 'POST', status: 404, body: refine });
  await foreign(`/proposals/${randomUUID()}/accept`, {
    method: 'POST',
    status: 404,
    body: { revision: 1, saveId: randomUUID() },
  });
  await foreign(`/proposals/${randomUUID()}/reject`, {
    method: 'POST',
    status: 404,
    body: {},
  });
  await api.request(`${base}/workflow-drafts/${draft.id}/generations`, {
    cookie: other.owner.cookie,
    status: 404,
  });

  // The evaluation corpus describes the same installed vocabulary as this workspace.
  const corpus = JSON.parse(
    await readFile(
      new URL(
        '../../../tooling/evaluation/fixtures/authoring-corpus.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const vocabulary = (await call(owner, '/workflow-authoring/vocabulary')).body;
  const identifiers = (words) => ({
    subjects: words.subjects.map((item) => item.kind),
    reads: words.reads.map(({ source, fields }) => ({ source, fields })),
    capabilities: words.capabilities.map(
      ({
        capability,
        version,
        targetKind,
        minimumRisk,
        parameters,
        postcondition,
        evaluators,
      }) => ({
        capability,
        version,
        targetKind,
        minimumRisk,
        parameters,
        postcondition,
        evaluators,
      }),
    ),
    evaluators: words.evaluators.map(({ version, fields }) => ({
      version,
      fields,
    })),
  });
  expect(identifiers(corpus.vocabulary)).toEqual(identifiers(vocabulary));
});

it('describes, refines and records a draft through the regional route without logging tenant text', async (t) => {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const api = await startApi(
    t,
    db,
    'http://localhost:3000',
    'e2e/authoring-server.mjs',
  );
  const { owner, member, base } = await workspace(api, 'authoring-route');
  const call = (user, path, options = {}) =>
    api.request(`${base}${path}`, { cookie: user.cookie, ...options });
  expect((await call(member, '/workflow-authoring/generation')).body).toEqual({
    available: true,
    reason: null,
    improvements: false,
    improvementDiscovery: false,
  });

  const prompt =
    'When SKU PRIVATE-4711 drops below 20 units, draft a purchase order for the usual supplier and ask me to approve it.';
  const request = { id: randomUUID(), draftId: randomUUID(), prompt };
  const described = (
    await call(owner, '/workflow-authoring/describe', {
      method: 'POST',
      body: request,
    })
  ).body;
  expect(described.draft).toEqual(
    expect.objectContaining({
      id: request.draftId,
      revision: 1,
      mode: 'language',
      state: 'draft',
    }),
  );
  expect(described.draft.content.definition.id).toMatch(/^low-stock-/);
  expect(described.generation).toEqual(
    expect.objectContaining({
      outcome: 'valid',
      attempts: 1,
      usage: { inputTokens: 120, outputTokens: 80, costUsd: null },
      route: {
        profile: 'authoring',
        adapter: 'bedrock',
        model: authoringModel,
      },
      questions: [
        {
          stepId: 'create-order',
          field: 'parameters.quantity',
          question: 'Should the quantity come from the replenishment proposal?',
        },
      ],
    }),
  );
  expect(described.generation.explanations).toHaveLength(8);
  expect(
    (
      await call(owner, '/workflow-authoring/describe', {
        method: 'POST',
        body: request,
      })
    ).body,
  ).toEqual(described);

  // The model can't introduce an action this workspace hasn't installed.
  const refund = (
    await call(owner, '/workflow-authoring/describe', {
      method: 'POST',
      body: {
        id: randomUUID(),
        draftId: randomUUID(),
        prompt: 'Issue a refund when stock is low.',
      },
    })
  ).body;
  expect(refund.generation).toEqual(
    expect.objectContaining({ outcome: 'partial', attempts: 3 }),
  );
  expect(
    refund.draft.content.steps.find((step) => step.id === 'create-order'),
  ).toEqual(expect.objectContaining({ capability: '', capabilityVersion: '' }));
  expect(refund.generation.questions).toContainEqual(
    expect.objectContaining({ stepId: 'create-order', field: 'capability' }),
  );
  expect(JSON.stringify(refund.draft)).not.toContain('payments.refund.create');

  const proposal = (
    await call(owner, `/workflow-drafts/${request.draftId}/proposals`, {
      method: 'POST',
      body: {
        id: randomUUID(),
        revision: 1,
        instruction: 'Wait ten minutes before checking stock.',
      },
    })
  ).body;
  expect(proposal).toEqual(
    expect.objectContaining({ state: 'open', baseRevision: 1 }),
  );
  expect(proposal.changes).toEqual([
    expect.objectContaining({
      change: 'added',
      stepId: 'settle',
      after: { id: 'settle', kind: 'wait', seconds: 600 },
    }),
  ]);
  expect(
    (await call(owner, `/workflow-drafts/${request.draftId}`)).body.revision,
  ).toBe(1);
  const accepted = (
    await call(
      owner,
      `/workflow-drafts/${request.draftId}/proposals/${proposal.id}/accept`,
      { method: 'POST', body: { revision: 1, saveId: randomUUID() } },
    )
  ).body;
  expect(accepted.draft).toEqual(
    expect.objectContaining({ revision: 2, state: 'draft', mode: 'language' }),
  );
  expect(accepted.proposal).toEqual(
    expect.objectContaining({ state: 'accepted', resultingRevision: 2 }),
  );

  // Code Steps need the Code Step runtime, which this server doesn't install.
  await call(
    owner,
    `/workflow-drafts/${request.draftId}/code-step-suggestions`,
    {
      method: 'POST',
      status: 409,
      body: {
        id: randomUUID(),
        revision: 2,
        stepId: null,
        description: 'Double the quantity.',
      },
    },
  );

  const records = (
    await call(member, `/workflow-drafts/${request.draftId}/generations`)
  ).body.items;
  expect(
    records.map((item) => [item.kind, item.outcome, item.proposalState]),
  ).toEqual(
    expect.arrayContaining([
      ['describe', 'valid', null],
      ['refine', 'valid', 'accepted'],
    ]),
  );
  expect(records).toHaveLength(2);
  expect(JSON.stringify(records)).not.toContain('PRIVATE-4711');
  const rows = await db.owner.query(
    'SELECT route, usage, result FROM workflow_generations',
  );
  expect(rows.rows).toHaveLength(3);
  expect(JSON.stringify(rows.rows)).not.toContain('PRIVATE-4711');

  // Nothing is published or started by generation.
  expect(
    (
      await db.owner.query(
        'SELECT count(*)::int AS n FROM playbook_versions WHERE definition_id LIKE $1',
        ['low-stock-%'],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(api.process.output).toContain('Request completed');
  expect(api.process.output).not.toContain('PRIVATE-4711');
  expect(api.process.output).not.toContain('Wait ten minutes');
});
