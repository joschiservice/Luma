import { randomUUID } from 'node:crypto';

import { replenishmentSource } from '@luma/procurement';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { database, signup, startApi } from './helpers.mjs';

/** A computation workflow that validates against the default installed vocabulary. */
export const checkOrder = {
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

it('saves, validates and publishes tenant drafts without activating them', async (t) => {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const api = await startApi(t, db);
  const owner = await signup(api, 'draft-owner');
  const member = await signup(api, 'draft-member');
  const org = (
    await api.request('/v1/organizations', {
      cookie: owner.cookie,
      method: 'POST',
      status: 201,
      body: { name: 'Authoring', slug: 'authoring', dataRegion: 'EU' },
    })
  ).body;
  await api.request(`/v1/organizations/${org.id}/members`, {
    cookie: owner.cookie,
    method: 'POST',
    status: 201,
    body: { userId: member.userId, roleId: 'member' },
  });
  const base = `/v1/organizations/${org.id}`;
  const call = (path, options = {}) =>
    api.request(`${base}${path}`, { cookie: owner.cookie, ...options });

  // The vocabulary comes from installed adapters and keeps unusable entries visible.
  const vocabulary = (await call('/workflow-authoring/vocabulary')).body;
  expect(
    vocabulary.capabilities.map((item) => [item.capability, item.executable]),
  ).toEqual(
    expect.arrayContaining([
      ['orders.shipping-method.write', false],
      ['procurement.purchase-order.create', false],
    ]),
  );
  expect(
    vocabulary.capabilities.every((item) => item.reason && !item.executable),
  ).toBe(true);
  expect(vocabulary.stepKinds).toHaveLength(9);

  // Templates list their requirements; customizing copies one into a new draft.
  const templates = (await call('/workflow-templates')).body.items;
  expect(templates.map((item) => [item.id, item.configure])).toEqual([
    ['inventory-replenishment', 'replenishment'],
    ['shipping-method-correction', 'resolution'],
    ['connection-sync-check', 'case'],
    ['shopify-stock-correction', 'case'],
    ['shopify-hold-release', 'case'],
  ]);
  // Case workflows need a Shopify connection with write access, so they explain what's missing.
  expect(
    templates.find((item) => item.id === 'shopify-stock-correction'),
  ).toMatchObject({ readiness: 'blocked', status: 'unavailable' });
  const replenishment = templates[0];
  expect(replenishment.readiness).toBe('blocked');
  expect(replenishment.requirements).toContainEqual(
    expect.objectContaining({
      label: 'A supplier',
      met: false,
      fix: { label: 'Add a supplier', destination: 'procurement' },
    }),
  );
  await api.request(
    `${base}/workflow-templates/shipping-method-correction/install`,
    { cookie: member.cookie, method: 'POST', status: 403, body: {} },
  );
  const installed = (
    await call('/workflow-templates/shipping-method-correction/install', {
      method: 'POST',
      body: {},
    })
  ).body;
  expect(installed).toEqual(
    expect.objectContaining({ installed: true, status: 'unavailable' }),
  );
  expect(
    (
      await call('/workflow-templates/shipping-method-correction/install', {
        method: 'POST',
        body: {},
      })
    ).body.installed,
  ).toBe(true);
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
  expect(copy.content.definition.id).toMatch(/^inventory-replenishment-/);
  expect(copy.content.steps.map((step) => step.id)).toEqual([
    'inventory',
    'fresh-stock',
    'proposal',
    'needs-order',
    'create-order',
    'verify-order',
    'complete',
  ]);
  const copied = (
    await call('/workflow-authoring/validate', {
      method: 'POST',
      body: { draftId: copy.id },
    })
  ).body;
  expect(
    copied.diagnostics.filter((item) => item.severity === 'error'),
  ).toEqual([]);
  expect(copied.publishable).toBe(true);
  // The copy publishes as a version equivalent to the reference definition.
  const equivalent = (
    await call(`/workflow-drafts/${copy.id}/publish`, {
      method: 'POST',
      body: { revision: copy.revision, notes: 'Custom replenishment' },
    })
  ).body;
  const reference = (
    await db.owner.query(
      'SELECT document FROM playbook_versions WHERE tenant_id=$1 AND definition_id=$2',
      [org.id, equivalent.version.definitionId],
    )
  ).rows[0].document;
  expect(reference.steps).toEqual(replenishmentSource.steps);
  expect(reference.applicability).toEqual(replenishmentSource.applicability);
  expect(reference.inputs).toEqual(replenishmentSource.inputs);
  expect(reference.context).toEqual(replenishmentSource.context);
  expect(reference.provenance.authoring.mode).toBe('template');
  expect(
    copied.diagnostics.some((item) =>
      item.message.includes('built-in Replenish low stock workflow'),
    ),
  ).toBe(true);
  // The code view prints and parses the same content without evaluating it.
  const printed = (
    await call('/workflow-authoring/validate', {
      method: 'POST',
      body: { code: copied.printed },
    })
  ).body;
  expect(printed.content).toEqual(copy.content);
  expect(printed.printed).toBe(copied.printed);
  const broken = (
    await call('/workflow-authoring/validate', {
      method: 'POST',
      body: { code: copied.printed.replace("'draft'", 'process.env.X') },
    })
  ).body;
  expect(broken.diagnostics[0]).toEqual(
    expect.objectContaining({ code: 'code_parse', field: 'code' }),
  );
  expect(broken.diagnostics[0].message).toMatch(/^Line \d+, column \d+:/);

  const id = randomUUID();
  const create = { id, mode: 'visual', start: { kind: 'blank', name: 'Hold' } };
  const draft = (
    await call('/workflow-drafts', { method: 'POST', body: create })
  ).body;
  expect(draft).toEqual(
    expect.objectContaining({ id, revision: 1, state: 'draft' }),
  );
  // An uncertain create is retried with the same body.
  expect(
    (await call('/workflow-drafts', { method: 'POST', body: create })).body,
  ).toEqual(draft);
  await call('/workflow-drafts', {
    method: 'POST',
    status: 409,
    body: { ...create, mode: 'code' },
  });

  // Incomplete content saves; validation explains what to fix on each step.
  const incomplete = {
    ...checkOrder,
    steps: [
      { ...checkOrder.steps[0], field: 'missing' },
      {
        id: 'act',
        kind: 'capability',
        capability: 'unknown.write',
        capabilityVersion: '1',
        targetKind: 'order',
        minimumRisk: 'low',
        parameters: {},
        expectedPostcondition: { done: { source: 'literal', value: true } },
      },
    ],
  };
  const saveId = randomUUID();
  const saved = (
    await call(`/workflow-drafts/${id}`, {
      method: 'PUT',
      body: { saveId, revision: 1, mode: 'visual', content: incomplete },
    })
  ).body;
  expect(saved.revision).toBe(2);
  expect(
    (
      await call(`/workflow-drafts/${id}`, {
        method: 'PUT',
        body: { saveId, revision: 1, mode: 'visual', content: incomplete },
      })
    ).body,
  ).toEqual(saved);
  const invalid = (
    await call('/workflow-authoring/validate', {
      method: 'POST',
      body: { draftId: id },
    })
  ).body;
  expect(invalid.publishable).toBe(false);
  expect(invalid.diagnostics.map((item) => [item.stepId, item.field])).toEqual(
    expect.arrayContaining([
      ['still-held', 'field'],
      ['act', 'kind'],
      ['act', 'capability'],
    ]),
  );
  await call(`/workflow-drafts/${id}/publish`, {
    method: 'POST',
    status: 409,
    body: { revision: 2 },
  });
  // Unreadable structure is rejected instead of being saved.
  await call(`/workflow-drafts/${id}`, {
    method: 'PUT',
    status: 409,
    body: {
      saveId: randomUUID(),
      revision: 2,
      mode: 'code',
      content: { ...checkOrder, steps: [{ id: 'x', kind: 'shell' }] },
    },
  });

  // Two editors saving the same revision: one wins, the other gets a conflict.
  const race = await Promise.all(
    ['first', 'second'].map(async (name) => {
      const response = await fetch(
        `${api.origin}${base}/workflow-drafts/${id}`,
        {
          method: 'PUT',
          headers: {
            origin: 'http://localhost:3000',
            cookie: owner.cookie,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            saveId: randomUUID(),
            revision: 2,
            mode: 'visual',
            content: {
              ...checkOrder,
              definition: { ...checkOrder.definition, name: `Held ${name}` },
            },
          }),
        },
      );

      return { status: response.status, body: await response.json() };
    }),
  );
  expect(race.map((item) => item.status).sort()).toEqual([200, 409]);
  const current = race.find((item) => item.status === 200).body;
  const fixed = (
    await call(`/workflow-drafts/${id}`, {
      method: 'PUT',
      body: {
        saveId: randomUUID(),
        revision: current.revision,
        mode: 'visual',
        content: checkOrder,
      },
    })
  ).body;

  // Members can read and validate, but not change or publish.
  const asMember = (path, options = {}) =>
    api.request(`${base}${path}`, { cookie: member.cookie, ...options });
  expect(
    (await asMember('/workflow-drafts')).body.items.map((item) => item.id),
  ).toContain(id);
  expect(
    (
      await asMember('/workflow-authoring/validate', {
        method: 'POST',
        body: { draftId: id },
      })
    ).body.publishable,
  ).toBe(true);
  await asMember(`/workflow-drafts/${id}`, {
    method: 'PUT',
    status: 403,
    body: {
      saveId: randomUUID(),
      revision: fixed.revision,
      mode: 'visual',
      content: checkOrder,
    },
  });
  await asMember(`/workflow-drafts/${id}/publish`, {
    method: 'POST',
    status: 403,
    body: { revision: fixed.revision },
  });

  const published = (
    await call(`/workflow-drafts/${id}/publish`, {
      method: 'POST',
      body: { revision: fixed.revision, notes: 'First release' },
    })
  ).body;
  expect(published.version).toEqual(
    expect.objectContaining({
      definitionId: 'order-hold-check',
      version: '1.0.0',
    }),
  );
  expect(
    (
      await call(`/workflow-drafts/${id}/publish`, {
        method: 'POST',
        body: { revision: fixed.revision, notes: 'First release' },
      })
    ).body,
  ).toEqual(published);
  const stored = (
    await db.owner.query(
      "SELECT document FROM playbook_versions WHERE tenant_id=$1 AND definition_id='order-hold-check'",
      [org.id],
    )
  ).rows[0].document;
  expect(stored.provenance).toEqual(
    expect.objectContaining({
      kind: 'native',
      authoring: {
        mode: 'visual',
        draftId: id,
        revision: fixed.revision,
        notes: 'First release',
      },
    }),
  );
  // Publication never activates or grants execution authority.
  const listed = (await call('/workflows')).body.items.find(
    (item) => item.id === 'order-hold-check',
  );
  expect(listed).toEqual(
    expect.objectContaining({ status: 'unavailable', activeVersions: [] }),
  );
  expect(listed.blockers.length).toBeGreaterThan(0);
  expect(
    (
      await db.owner.query(
        'SELECT count(*)::int AS count FROM playbook_activations WHERE tenant_id=$1',
        [org.id],
      )
    ).rows[0].count,
  ).toBe(0);

  // Editing the published workflow starts a new draft with the next version.
  const edit = (
    await call('/workflow-drafts', {
      method: 'POST',
      body: {
        id: randomUUID(),
        mode: 'visual',
        start: {
          kind: 'version',
          definitionId: 'order-hold-check',
          version: '1.0.0',
        },
      },
    })
  ).body;
  expect(edit.content.version).toBe('1.1.0');
  expect(edit.basedOn.digest).toBe(published.version.digest);
  expect(
    (
      await call(`/workflow-drafts/${edit.id}/discard`, {
        method: 'POST',
        body: { revision: 1 },
      })
    ).body,
  ).toEqual({ discarded: true });
  await call(`/workflow-drafts/${edit.id}`, { status: 404 });

  expect(
    (
      await db.owner.query(
        "SELECT document->>'eventType' AS type FROM audit_entries WHERE tenant_id=$1 AND document->>'eventType' LIKE 'workflow.%' ORDER BY type",
        [org.id],
      )
    ).rows.map((row) => row.type),
  ).toEqual([
    'workflow.draft_created',
    'workflow.draft_created',
    'workflow.draft_created',
    'workflow.draft_discarded',
    'workflow.published',
    'workflow.published',
  ]);

  // Drafts are invisible to other workspaces, including under RLS.
  const outsider = await signup(api, 'draft-outsider');
  await api.request(`${base}/workflow-drafts/${id}`, {
    cookie: outsider.cookie,
    status: 404,
  });
  const other = (
    await api.request('/v1/organizations', {
      cookie: outsider.cookie,
      method: 'POST',
      status: 201,
      body: { name: 'Other', slug: 'other-authoring', dataRegion: 'EU' },
    })
  ).body;
  await api.request(`/v1/organizations/${other.id}/workflow-drafts/${id}`, {
    cookie: outsider.cookie,
    status: 404,
  });
  expect(
    (
      await api.request(`/v1/organizations/${other.id}/workflow-drafts`, {
        cookie: outsider.cookie,
      })
    ).body.items,
  ).toEqual([]);
  const runtime = new Pool({ connectionString: db.runtimeUrl });
  t.onTestFinished(() => runtime.end());
  const tx = await runtime.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT set_config('app.tenant_id',$1,true)", [other.id]);
    expect((await tx.query('SELECT id FROM workflow_drafts')).rows).toEqual([]);
    await expect(
      tx.query(
        "INSERT INTO workflow_drafts(tenant_id,id,revision,state,mode,content,author_id,updated_by,created_at,updated_at,create_digest) VALUES($1,$2,1,'draft','visual','{}',$3,$3,now(),now(),'x')",
        [org.id, randomUUID(), owner.userId],
      ),
    ).rejects.toThrow();
    await tx.query('ROLLBACK');
  } finally {
    tx.release();
  }
});
