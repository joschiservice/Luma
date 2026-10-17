import { randomUUID } from 'node:crypto';

import { expect, test } from './browser-fixtures.mjs';
import {
  availablePort,
  createAccount,
  database,
  startApi,
  startProcess,
} from './helpers.mjs';
import { seedResolutionMeasurement } from './resolution-measurement-fixture.mjs';

/** Retains synthetic learning history with the same immutable bindings as the runtime owners. */
async function retainRun(f, issue) {
  const runId = randomUUID(),
    digest = 'a'.repeat(64),
    tenant = f.org.id;
  const run = {
    id: runId,
    schemaVersion: 1,
    incidentId: issue.id,
    actorId: f.owner.id,
    diagnosisRevision: 1,
    createdAt: issue.verifiedAt,
    resolution: {
      id: 'stock-repair',
      version: '1',
      use: 'reused',
      reasonCode: 'review',
    },
    context: {
      evidenceRefs: [issue.evidence],
      mappingVersions: [],
      configVersion: 'fixture/1',
      ruleVersion: 'v0.1',
      diagnosisVersion: '1',
      hypotheses: [],
      model: { status: 'disabled', model: null, promptVersion: null },
    },
    generation: { kind: 'manual', reference: 'synthetic-browser' },
    artifactDigest: digest,
  };
  await f.db.owner.query(
    'INSERT INTO exception_diagnoses(tenant_id,exception_id,revision,revision_key,snapshot,document) VALUES($1,$2,1,$3,$4,$5)',
    [
      tenant,
      issue.id,
      randomUUID(),
      {},
      { exceptionId: issue.id, revision: 1, schemaVersion: 1, status: 'ready' },
    ],
  );
  await f.db.owner.query(
    'INSERT INTO action_artifacts(tenant_id,id,version,digest,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [
      tenant,
      'stock-repair',
      '1',
      digest,
      {
        id: 'stock-repair',
        version: '1',
        generation: run.generation,
        steps: {},
      },
    ],
  );
  await f.db.owner.query(
    'INSERT INTO resolution_runs(tenant_id,id,incident_id,diagnosis_revision,artifact_id,artifact_version,document,request,actor_id) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',
    [tenant, runId, issue.id, 'stock-repair', '1', run, {}, f.owner.id],
  );
  const facts = [
    {
      kind: 'outcome',
      result: 'verified',
      authoritative: true,
      complete: true,
      evidenceRefs: [issue.evidence],
      evaluatorVersion: 'fixture/1',
      businessResult: { code: 'stock-agrees', value: null, unit: null },
    },
    {
      kind: 'intervention',
      stepId: 'review',
      reasonCode: 'review',
      effortSeconds: 20,
      evidenceRefs: [issue.evidence],
    },
  ];
  for (const [index, fact] of facts.entries()) {
    const id = randomUUID();
    await f.db.owner.query(
      'INSERT INTO resolution_learning_events(tenant_id,id,run_id,sequence,kind,document,request,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        tenant,
        id,
        runId,
        index + 1,
        fact.kind,
        {
          id,
          occurredAt: issue.verifiedAt,
          recordedAt: issue.verifiedAt,
          actorId: f.owner.id,
          sequence: index + 1,
          fact,
        },
        {},
        f.owner.id,
      ],
    );
  }

  return runId;
}

test('discovers evidence explicitly, compares an immutable candidate and rejects without changing the draft', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const api = await startApi(
    t,
    db,
    origin,
    'e2e/workflow-improvements-server.mjs',
  );
  await startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: api.origin, TEST_WEB_PORT: String(port) },
    true,
  ).message('listening');
  const page = await t.newPage({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await createAccount(page, db, {
    name: 'Improver',
    email: 'improver@example.test',
    password: 'browser-test-password-123',
  });
  await page.getByLabel('Workspace name').fill('Improvement studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Needs you' }).waitFor();
  const tenant = new URL(page.url()).pathname.split('/')[2];
  await page.goto(`/app/${tenant}/workflows/new`);
  await page.getByRole('button', { name: 'Describe a workflow' }).click();
  const dialog = page.getByRole('dialog', { name: 'Describe a workflow' });
  await dialog
    .getByLabel('What should happen?')
    .fill(
      'When stock drops below minimum draft a purchase order with approval.',
    );
  await dialog.getByRole('button', { name: 'Draft workflow' }).click();
  await page
    .getByRole('heading', { name: 'Reorder low stock', level: 1 })
    .waitFor();
  await page.getByText('All changes saved').waitFor();
  const assistant = page.getByRole('region', { name: 'From your description' });
  await assistant
    .getByText('Learn from a verified resolution', { exact: true })
    .click();
  await assistant
    .getByRole('button', { name: 'Discover recurring verified work' })
    .click();
  await assistant
    .getByText('No supported verified patterns were found in this window.')
    .waitFor();
  const cookie = (await page.context().cookies())
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const user = (
    await db.owner.query('SELECT id FROM users WHERE email=$1', [
      'improver@example.test',
    ])
  ).rows[0];
  const f = {
    db,
    org: { id: tenant },
    owner: { id: user.id },
    base: `/v1/organizations/${tenant}`,
    request: async (_user, path, method = 'GET', body, status = 200) =>
      (await api.request(path, { cookie, method, body, status })).body,
  };
  for (let i = 0; i < 3; i++)
    await retainRun(
      f,
      await seedResolutionMeasurement(f, {
        synthetic: true,
        environment: 'synthetic',
      }),
    );
  await assistant
    .getByRole('button', { name: 'Discover recurring verified work' })
    .click();
  await assistant.getByText('Synthetic evidence', { exact: true }).waitFor();
  await assistant
    .getByRole('button', { name: /Use evidence for SKU-/ })
    .first()
    .click();
  await assistant
    .getByLabel('What should change?')
    .fill('Wait ten minutes before checking stock.');
  await assistant.getByRole('button', { name: 'Propose change' }).click();
  const proposal = assistant.getByLabel('Proposed change');
  await proposal
    .getByText('Review improvement evidence', { exact: true })
    .click();
  await proposal.getByText('8 trusted synthetic comparisons passed.').waitFor();
  await proposal.getByText('Restart and replay', { exact: false }).waitFor();
  const draftId = new URL(page.url()).pathname.split('/').at(-1);
  const before = (
    await api.request(`${f.base}/workflow-drafts/${draftId}`, { cookie })
  ).body;
  await proposal.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(assistant.getByLabel('Proposed change')).toHaveCount(0);
  const after = (
    await api.request(`${f.base}/workflow-drafts/${draftId}`, { cookie })
  ).body;
  expect(after.revision).toBe(before.revision);
  expect(after.content).toEqual(before.content);
  expect(
    (
      await db.owner.query(
        'SELECT proposal_state AS state,result FROM workflow_generations WHERE tenant_id=$1 AND kind=$2',
        [tenant, 'refine'],
      )
    ).rows[0],
  ).toMatchObject({
    state: 'rejected',
    result: { improvement: { coverage: 'synthetic_passed' } },
  });
  expect(errors).toEqual([]);
});
