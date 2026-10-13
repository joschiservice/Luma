import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';
import { expect, it } from 'vitest';

import { setupSimulator } from './simulator-fixture.mjs';

const origin = 'http://127.0.0.1:3000';
const flags = {
  'adaptive-custom-fields': true,
  'adaptive-saved-views': true,
  'adaptive-view-actions': true,
  'adaptive-operational-packages': true,
  'procurement-supplier-follow-ups': true,
};

async function workspace(t) {
  const observability = createObservability({
    environment: 'test',
    release: 'adaptive-journey',
    approvedModels: [],
    featureFlagOverrides: flags,
  });
  t.onTestFinished(() => observability.shutdown());
  const f = await setupSimulator(t, {
    observability,
    featureFlagOverrides: flags,
  });
  const login = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin },
    payload: { email: 'pilot-operator@example.test', password: f.password },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = []
    .concat(login.headers['set-cookie'])
    .map((v) => v.split(';')[0])
    .join('; ');
  const root = `/v1/organizations/${f.manifest.organizationId}/adaptive`;
  const request = async (
    path,
    body,
    { method = body ? 'POST' : 'GET', status = 200 } = {},
  ) => {
    const response = await f.pilot.app.inject({
      method,
      url: path.startsWith('/v1/') ? path : root + path,
      headers: { origin, cookie },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(response.statusCode, status, response.body);

    return response.json();
  };

  return { ...f, request, cookie };
}

it('installs and evolves one purchasing package in two isolated simulator workspaces while preserving local choices', async (t) => {
  const [a, b] = await Promise.all([workspace(t), workspace(t)]);
  const configurations = [
    {
      parameters: {
        mailboxId: a.manifest.connections.gmail,
        nextCheckHours: 24,
        fieldLabelEn: 'Purchasing note',
        fieldLabelDe: 'Einkaufsnotiz',
        fieldReadPermission: 'adaptive.fields.read',
        fieldWritePermission: 'adaptive.fields.write',
      },
      sharing: { scope: 'workspace', roleIds: [] },
    },
    {
      parameters: {
        mailboxId: b.manifest.connections.gmail,
        nextCheckHours: 72,
        fieldLabelEn: 'Buyer escalation',
        fieldLabelDe: 'Einkaufseskalation',
        fieldReadPermission: 'procurement.read',
        fieldWritePermission: 'procurement.manage',
      },
      sharing: { scope: 'roles', roleIds: ['admin'] },
    },
  ];
  for (const [index, f] of [a, b].entries()) {
    const config = configurations[index];
    expect(config.parameters.mailboxId).toBeTruthy();
    const invalid = {
      version: '1.0.0',
      config: {
        ...config,
        parameters: { ...config.parameters, mailboxId: randomUUID() },
      },
    };
    const unavailable = await f.request(
      '/packages/supplier-confirmations/preview',
      invalid,
    );
    expect(unavailable.canInstall).toBe(false);
    await f.request(
      '/packages/supplier-confirmations/install',
      {
        ...invalid,
        commandId: randomUUID(),
        reviewDigest: unavailable.reviewDigest,
      },
      { status: 409 },
    );
    expect((await f.request('/views')).items).toEqual([]);
    const initial = { version: '1.0.0', config };
    const preview = await f.request(
      '/packages/supplier-confirmations/preview',
      initial,
    );
    expect(preview).toMatchObject({
      canInstall: true,
      permissionsGranted: [],
      workflowsActivate: false,
    });
    const before = async () => ({
      views: (await f.request('/views')).items,
      fields: await f.request('/fields?recordType=purchase_order'),
      workflows: (
        await f.db.owner.query(
          'SELECT count(*)::int AS count FROM playbook_versions WHERE tenant_id=$1',
          [f.manifest.organizationId],
        )
      ).rows[0].count,
    });
    const untouched = await before();
    const mailbox = (
      await f.db.owner.query(
        'SELECT document FROM connector_installations WHERE tenant_id=$1 AND id=$2',
        [f.manifest.organizationId, config.parameters.mailboxId],
      )
    ).rows[0].document;
    for (const blocked of [
      { ...mailbox, status: 'degraded' },
      {
        ...mailbox,
        granted: mailbox.granted.filter(
          (capability) => capability !== 'messages.send',
        ),
      },
    ]) {
      await f.db.owner.query(
        'UPDATE connector_installations SET document=$3::jsonb WHERE tenant_id=$1 AND id=$2',
        [
          f.manifest.organizationId,
          config.parameters.mailboxId,
          JSON.stringify(blocked),
        ],
      );
      const unavailable = await f.request(
        '/packages/supplier-confirmations/preview',
        initial,
      );
      expect(unavailable.canInstall).toBe(false);
      await f.request(
        '/packages/supplier-confirmations/install',
        {
          ...initial,
          commandId: randomUUID(),
          reviewDigest: preview.reviewDigest,
        },
        { status: 409 },
      );
      expect(await before()).toEqual(untouched);
    }
    await f.db.owner.query(
      'UPDATE connector_installations SET document=$3::jsonb WHERE tenant_id=$1 AND id=$2',
      [
        f.manifest.organizationId,
        config.parameters.mailboxId,
        JSON.stringify(mailbox),
      ],
    );
    const operator = await f.pilot.operator();
    const membership = (
      await f.db.owner.query(
        'SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2',
        [operator.tenantId, operator.actor.id],
      )
    ).rows[0];
    await f.db.owner.query(
      "UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",
      [operator.tenantId, operator.actor.id],
    );
    await f.request(
      '/packages/supplier-confirmations/install',
      {
        ...initial,
        commandId: randomUUID(),
        reviewDigest: preview.reviewDigest,
      },
      { status: 403 },
    );
    await f.db.owner.query(
      'UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2',
      [operator.tenantId, operator.actor.id, membership.role],
    );
    const limitedRole = randomUUID();
    await f.db.owner.query(
      "INSERT INTO workspace_roles(tenant_id,id,name,created_by) VALUES($1,$2,'Package viewer without field authority',$3)",
      [operator.tenantId, limitedRole, operator.actor.id],
    );
    await f.db.owner.query(
      "INSERT INTO workspace_role_permissions(tenant_id,role_id,permission) VALUES($1,$2,'adaptive.packages.manage')",
      [operator.tenantId, limitedRole],
    );
    await f.db.owner.query(
      "UPDATE memberships SET role='custom',custom_role_id=$3 WHERE tenant_id=$1 AND user_id=$2",
      [operator.tenantId, operator.actor.id, limitedRole],
    );
    await f.request(
      '/packages/supplier-confirmations/install',
      {
        ...initial,
        commandId: randomUUID(),
        reviewDigest: preview.reviewDigest,
      },
      { status: 403 },
    );
    await f.db.owner.query(
      'UPDATE memberships SET role=$3,custom_role_id=NULL WHERE tenant_id=$1 AND user_id=$2',
      [operator.tenantId, operator.actor.id, membership.role],
    );
    expect(await before()).toEqual(untouched);
    const command = {
      ...initial,
      commandId: randomUUID(),
      reviewDigest: preview.reviewDigest,
    };
    const installed = await f.request(
      '/packages/supplier-confirmations/install',
      command,
    );
    expect(
      await f.request('/packages/supplier-confirmations/install', command),
    ).toEqual(installed);
    expect(
      installed.installed.resources.filter((r) => r.kind === 'workflow'),
    ).toHaveLength(1);
    const viewId = installed.installed.resources.find(
      (r) => r.kind === 'view',
    ).id;
    const view = await f.request(`/views/${viewId}`);
    await f.request(
      `/views/${viewId}`,
      {
        commandId: randomUUID(),
        name: `Local team ${index}`,
        description: view.description,
        sharing: view.sharing,
        query: view.query,
        reviewed: true,
        expectedRevision: view.revision,
      },
      { method: 'PUT' },
    );
    const next = { version: '1.1.0', config };
    const upgrade = await f.request(
      '/packages/supplier-confirmations/preview',
      next,
    );
    const updated = await f.request(
      '/packages/supplier-confirmations/install',
      { ...next, commandId: randomUUID(), reviewDigest: upgrade.reviewDigest },
    );
    expect(updated.installed.config).toEqual(config);
    expect(
      updated.installed.resources.filter((r) => r.kind === 'view'),
    ).toHaveLength(2);
    expect((await f.request(`/views/${viewId}`)).name).toBe(
      `Local team ${index}`,
    );
    const fieldId = updated.installed.resources.find(
      (r) => r.kind === 'field',
    ).id;
    const fields = await f.request('/fields?recordType=purchase_order');
    expect(fields.find((field) => field.id === fieldId).label.en).toBe(
      config.parameters.fieldLabelEn,
    );
    expect(
      (await f.request('/views')).items.find((view) => view.id === viewId).query
        .actions[0].inputs.nextCheckHours.value,
    ).toBe(config.parameters.nextCheckHours);
    const procurement = `/v1/organizations/${f.manifest.organizationId}/procurement`;
    const supplier = await f.request(`${procurement}/suppliers`, {
      id: randomUUID(),
      name: `Package supplier ${index}`,
      email: `supplier-${index}@example.test`,
      externalReferences: [],
    });
    const order = await f.request(`${procurement}/purchase-orders`, {
      id: randomUUID(),
      supplierId: supplier.id,
      reference: `ADAPTIVE-${index}`,
      lines: [
        {
          id: randomUUID(),
          sku: 'fixture-sku',
          description: 'Fixture purchase',
          quantity: 4,
          unit: 'each',
        },
      ],
    });
    const recordPath = `/fields/records/purchase_order/${order.id}`;
    await f.request(
      recordPath,
      {
        values: [
          { fieldId, value: `Preserve buyer decision ${index}`, revision: 0 },
        ],
      },
      { method: 'PUT' },
    );
    const uninstall = {
      commandId: randomUUID(),
      revision: updated.installed.revision,
    };
    const workflowId = updated.installed.resources.find(
      (resource) => resource.kind === 'workflow',
    ).id;
    const workflowVersion = (
      await f.db.owner.query(
        'SELECT version,digest FROM playbook_versions WHERE tenant_id=$1 AND definition_id=$2 ORDER BY version LIMIT 1',
        [f.manifest.organizationId, workflowId],
      )
    ).rows[0];
    const workflowRoot = `/v1/organizations/${f.manifest.organizationId}/workflows/${workflowId}`;
    const occurredAt = new Date().toISOString();
    const run = await f.request(`${workflowRoot}/starts`, {
      version: workflowVersion.version,
      reviewedDigest: workflowVersion.digest,
      subject: { kind: 'purchase_order', id: order.id },
      signal: { kind: 'manual', sourceId: randomUUID(), occurredAt },
      context: {
        inputs: { purchaseOrderId: order.id },
        evidence: {
          kind: 'supplier_confirmation',
          facts: { attentionKey: 'manual-package-review' },
          observations: [
            {
              id: randomUUID(),
              observedAt: occurredAt,
              source: 'reviewed-workspace-input',
            },
          ],
        },
        provenance: {
          reference: 'package-lifecycle-journey',
          capturedAt: occurredAt,
        },
      },
    });
    const beforeRemovalView = await f.request(`/views/${viewId}`);
    await f.request('/packages/supplier-confirmations/uninstall', uninstall, {
      status: 409,
    });
    expect((await f.request(`/views/${viewId}`)).revision).toBe(
      beforeRemovalView.revision,
    );
    expect(
      (await f.request('/fields?recordType=purchase_order')).some(
        (field) => field.id === fieldId,
      ),
    ).toBe(true);
    expect(
      (await f.request(recordPath)).values.find(
        (value) => value.fieldId === fieldId,
      ).value,
    ).toBe(`Preserve buyer decision ${index}`);
    await f.request(`${workflowRoot}/starts/${run.id}/cancel`, {});

    expect(
      await f.request('/packages/supplier-confirmations/uninstall', uninstall),
    ).toEqual({ removed: true });
    expect(
      await f.request('/packages/supplier-confirmations/uninstall', uninstall),
    ).toEqual({ removed: true });
    expect((await f.request('/views')).items).toHaveLength(0);
    expect(
      (await f.request('/fields?recordType=purchase_order')).some(
        (field) => field.id === fieldId,
      ),
    ).toBe(false);
    const retainedOrder = await f.request(
      `${procurement}/purchase-orders/${order.id}`,
    );
    expect(retainedOrder.order.id).toBe(order.id);
    expect(retainedOrder.order.lines[0].quantity).toBe(4);
    const retainedValue = (
      await f.db.owner.query(
        'SELECT value FROM adaptive_field_values WHERE tenant_id=$1 AND field_id=$2 AND record_id=$3',
        [f.manifest.organizationId, fieldId, order.id],
      )
    ).rows[0].value;
    expect(retainedValue).toBe(`Preserve buyer decision ${index}`);
    expect(
      (await f.request('/packages')).items.find(
        (item) => item.id === 'supplier-confirmations',
      ).retainedConfig,
    ).toEqual(config);
    const altered = {
      version: '1.1.0',
      config: {
        ...config,
        parameters: {
          ...config.parameters,
          nextCheckHours: config.parameters.nextCheckHours + 1,
        },
      },
    };
    const alteredPreview = await f.request(
      '/packages/supplier-confirmations/preview',
      altered,
    );
    await f.request(
      '/packages/supplier-confirmations/install',
      {
        ...altered,
        commandId: randomUUID(),
        reviewDigest: alteredPreview.reviewDigest,
      },
      { status: 409 },
    );
    expect((await f.request('/views')).items).toHaveLength(0);
    const repreview = await f.request(
      '/packages/supplier-confirmations/preview',
      next,
    );
    const restored = await f.request(
      '/packages/supplier-confirmations/install',
      {
        ...next,
        commandId: randomUUID(),
        reviewDigest: repreview.reviewDigest,
      },
    );
    expect(restored.installed.resources).toEqual(updated.installed.resources);
    expect(restored.installed.config).toEqual(config);
    expect(
      (
        await f.db.owner.query(
          'SELECT state FROM workflow_trigger_runs WHERE tenant_id=$1 AND id=$2',
          [f.manifest.organizationId, run.id],
        )
      ).rows[0].state,
    ).toBe('cancelled');
    expect((await f.request(`/views/${viewId}`)).name).toBe(
      `Local team ${index}`,
    );
    expect(
      (await f.request(recordPath)).values.find(
        (value) => value.fieldId === fieldId,
      ).value,
    ).toBe(`Preserve buyer decision ${index}`);
    if (index === 0) {
      const actor = await f.pilot.operator();
      const artifact = await f.pilot.safety.provisioning.activate(actor, {
        id: 'cancellation-first-action',
        version: '1',
        generation: { kind: 'manual', reference: 'cancellation-journey' },
        steps: {
          first: {
            capability: 'stock.correct',
            capabilityVersion: '1',
            targetKind: 'sku',
            minimumRisk: 'low',
          },
        },
      });
      const bindingFor = (runId) => ({
        runId,
        stepId: 'first',
        tenantId: actor.tenantId,
        principalId: actor.actor.id,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        subject: { kind: 'purchase_order', id: order.id },
        action: {
          schemaVersion: 1,
          id: randomUUID(),
          tenantId: actor.tenantId,
          capability: 'stock.correct',
          capabilityVersion: '1',
          connectionId: f.manifest.connections.shopify,
          target: { kind: 'sku', id: randomUUID() },
          parameters: {},
          preconditions: {
            evidenceRefs: [randomUUID()],
            validUntil: new Date(Date.now() + 300000).toISOString(),
          },
          expectedPostcondition: {},
          risk: 'low',
          proposedBy: { kind: 'user', id: actor.actor.id },
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        },
      });
      await expect(
        f.pilot.safety.provisioning.bind(actor, bindingFor(run.id)),
      ).rejects.toMatchObject({ statusCode: 409 });
      const startRequest = {
        version: workflowVersion.version,
        reviewedDigest: workflowVersion.digest,
        subject: { kind: 'purchase_order', id: order.id },
        signal: { kind: 'manual', sourceId: randomUUID(), occurredAt },
        context: {
          inputs: { purchaseOrderId: order.id },
          evidence: {
            kind: 'supplier_confirmation',
            facts: { attentionKey: 'manual-package-review' },
            observations: [
              {
                id: randomUUID(),
                observedAt: occurredAt,
                source: 'reviewed-workspace-input',
              },
            ],
          },
          provenance: {
            reference: 'package-lifecycle-journey',
            capturedAt: occurredAt,
          },
        },
      };
      const prebound = await f.request(`${workflowRoot}/starts`, startRequest);
      await f.pilot.safety.provisioning.bind(actor, bindingFor(prebound.id));
      expect(
        (
          await f.db.owner.query(
            'SELECT count(*)::int AS count FROM workflow_process_steps WHERE tenant_id=$1 AND run_id=$2',
            [actor.tenantId, prebound.id],
          )
        ).rows[0].count,
      ).toBe(0);
      await f.request(
        `${workflowRoot}/starts/${prebound.id}/cancel`,
        {},
        { status: 409 },
      );
      const raced = await f.request(`${workflowRoot}/starts`, {
        ...startRequest,
        signal: { ...startRequest.signal, sourceId: randomUUID() },
      });
      const [binding, cancellation] = await Promise.allSettled([
        f.pilot.safety.provisioning.bind(actor, bindingFor(raced.id)),
        f.pilot.app.inject({
          method: 'POST',
          url: `${workflowRoot}/starts/${raced.id}/cancel`,
          headers: { origin, cookie: f.cookie },
          payload: {},
        }),
      ]);
      expect(cancellation.status).toBe('fulfilled');
      if (binding.status === 'fulfilled')
        expect(cancellation.value.statusCode).toBe(409);
      else {
        expect(binding.reason).toMatchObject({ statusCode: 409 });
        expect(cancellation.value.statusCode).toBe(200);
      }
    }
  }
  const aView = (await a.request('/views')).items[0].id;
  await b.request(`/views/${aView}`, undefined, { status: 404 });
}, 120000);
