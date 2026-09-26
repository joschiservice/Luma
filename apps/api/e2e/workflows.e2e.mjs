import { randomUUID } from 'node:crypto';

import { makeTenantContext } from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { shippingMethodPlaybook } from '@luma/resolution';
import { resolutionWorkflow } from '@luma/workflows';
import {
  compilePlaybook,
  createWorkflows,
  defineWorkflow,
} from '@luma/workflows/composition';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { database, signup, startApi } from './helpers.mjs';
import { seedPlaybooks } from './playbooks-fixture.mjs';

it('publishes native workflows without cases, retains immutable versions and exposes both formats through the Workflow catalog', async (t) => {
  const db = await database(t);
  await db.migrate();
  await db.owner.query(
    `GRANT luma_identity,luma_connectors,luma_case_reader,luma_desk TO "${new URL(db.runtimeUrl).username}"`,
  );
  const api = await startApi(t, db);
  const user = await signup(api, 'workflow-author');
  const org = (
    await api.request('/v1/organizations', {
      cookie: user.cookie,
      method: 'POST',
      status: 201,
      body: { name: 'Workflows', slug: 'workflows', dataRegion: 'EU' },
    })
  ).body;
  const tenantId = org.id;
  const membership = (
    await db.owner.query(
      'SELECT id FROM memberships WHERE tenant_id=$1 AND user_id=$2',
      [tenantId, user.userId],
    )
  ).rows[0];
  const context = makeTenantContext(
    { userId: user.userId, sessionId: 'test' },
    { ...org, status: 'active' },
    {
      id: membership.id,
      organizationId: tenantId,
      userId: user.userId,
      role: 'owner',
    },
    'publication',
  );
  const pool = new Pool({ connectionString: db.runtimeUrl });
  t.onTestFinished(() => pool.end());
  const tenantDb = createTenantDatabase(pool);
  // Publication only uses the owner store and refreshed membership, never execution controls.
  const catalog = createWorkflows(tenantDb, {}, async () => context);
  const projected = resolutionWorkflow(compilePlaybook(shippingMethodPlaybook));
  const { digest, format, ...source } = projected;
  expect(digest).toHaveLength(64);
  expect(format).toBe('resolution-playbook/0');
  const native = defineWorkflow({
    ...source,
    definition: {
      ...source.definition,
      id: 'manual-order-review',
      category: 'operations',
    },
    applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
  });
  expect(await catalog.publish(context, native)).toEqual(native);
  expect(await catalog.publish(context, native)).toEqual(native);
  await expect(
    catalog.publish(context, {
      ...source,
      definition: native.definition,
      applicability: native.applicability,
      inputs: { ...source.inputs, reviewId: 'string' },
    }),
  ).rejects.toThrow('version is immutable');
  const legacy = await seedPlaybooks(db, tenantId);
  const root = `/v1/organizations/${tenantId}`;
  const items = (
    await api.request(`${root}/workflows`, { cookie: user.cookie })
  ).body.items;
  expect(items.map((v) => v.id).sort()).toEqual(
    [native.definition.id, legacy.version.definition.id].sort(),
  );
  const detail = (
    await api.request(`${root}/workflows/${native.definition.id}`, {
      cookie: user.cookie,
    })
  ).body;
  expect(detail.summary).toMatchObject({
    category: 'operations',
    status: 'unavailable',
  });
  expect(detail.versions[0]).toMatchObject({
    digest: native.digest,
    format: 'workflow/1',
    applicability: native.applicability,
    compatible: false,
  });
  expect(
    (
      await api.request(`${root}/workflows/${native.definition.id}/runs`, {
        cookie: user.cookie,
      })
    ).body.items,
  ).toEqual([]);
  expect(
    (await api.request(`${root}/playbooks`, { cookie: user.cookie })).body
      .items,
  ).toHaveLength(1);
  await api.request(`${root}/workflows/${native.definition.id}/activations`, {
    cookie: user.cookie,
    method: 'POST',
    status: 409,
    body: {
      id: randomUUID(),
      version: native.version,
      reviewedDigest: native.digest,
      policyVersion: 'v0.1',
      connectionId: legacy.connectionId,
      connectionVersion: 2,
      targetIds: [legacy.targetId],
      scopeReviewed: true,
    },
  });
  const outsider = await signup(api, 'workflow-outsider');
  await api.request(`${root}/workflows/${native.definition.id}`, {
    cookie: outsider.cookie,
    status: 404,
  });
  // Caller-supplied actors never create an agent authorization path.
  await api.request(
    `${root}/workflows/${legacy.version.definition.id}/activations`,
    {
      cookie: user.cookie,
      method: 'POST',
      status: 400,
      body: {
        id: randomUUID(),
        version: legacy.version.version,
        reviewedDigest: legacy.version.digest,
        policyVersion: 'v0.1',
        connectionId: legacy.connectionId,
        connectionVersion: 2,
        targetIds: [legacy.targetId],
        scopeReviewed: true,
        actor: { kind: 'agent', id: 'agent' },
      },
    },
  );
});
