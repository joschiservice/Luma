import { randomUUID } from 'node:crypto';

import { shippingMethodPlaybook } from '@luma/resolution';
import { compilePlaybook } from '@luma/resolution/composition';
import { expect, it } from 'vitest';

import { database, signup, startApi } from './helpers.mjs';
import { seedPlaybooks } from './playbooks-fixture.mjs';

for (const transport of ['playbooks', 'workflows']) {
  it(`${transport} persists exact reviewed grants and preserves tenant isolation, replay and revocation`, async (t) => {
    const db = await database(t);
    await db.migrate();
    await db.owner.query(
      `GRANT luma_identity,luma_connectors,luma_case_reader,luma_desk TO "${new URL(db.runtimeUrl).username}"`,
    );
    const api = await startApi(t, db);
    const owner = await signup(api, 'playbook-owner');
    const member = await signup(api, 'playbook-member');
    const outsider = await signup(api, 'playbook-outsider');
    const created = await api.request('/v1/organizations', {
      method: 'POST',
      cookie: owner.cookie,
      body: {
        name: 'Playbook workspace',
        slug: 'playbook-workspace',
        dataRegion: 'EU',
      },
      status: 201,
    });
    const tenantId = created.body.id;
    await db.owner.query(
      'INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,$4,now())',
      [randomUUID(), tenantId, member.userId, 'member'],
    );
    const { version, connectionId, targetId } = await seedPlaybooks(
      db,
      tenantId,
    );
    const root = `/v1/organizations/${tenantId}/${transport}`,
      path = `${root}/${version.definition.id}`;
    const read = (suffix = '') =>
      api.request(path + suffix, { cookie: owner.cookie });
    const command = {
      id: randomUUID(),
      version: version.version,
      reviewedDigest: version.digest,
      policyVersion: 'v0.1',
      connectionId,
      connectionVersion: 2,
      targetIds: [targetId],
      scopeReviewed: true,
    };
    const activate = (body = command, status = 200, cookie = owner.cookie) =>
      api.request(`${path}/activations`, {
        method: 'POST',
        cookie,
        body,
        status,
      });
    // The workflows list also includes built-in workflows, so select this definition by ID.
    expect(
      (await api.request(root, { cookie: member.cookie })).body.items.find(
        (item) => item.id === version.definition.id,
      ).status,
    ).toBe('inactive');
    expect(
      (await api.request(path, { cookie: member.cookie })).body.canManage,
    ).toBe(false);
    await activate(command, 403, member.cookie);
    await activate(command, 404, outsider.cookie);
    await activate({ ...command, reviewedDigest: '0'.repeat(64) }, 409);
    await activate({ ...command, policyVersion: 'old' }, 409);
    await activate({ ...command, connectionVersion: 1 }, 409);
    await activate({ ...command, connectionId: randomUUID() }, 404);
    await activate({ ...command, targetIds: [randomUUID()] }, 409);
    await activate({ ...command, scopeReviewed: false }, 400);
    await db.owner.query(
      `UPDATE connector_installations SET document=jsonb_set(document,'{granted}','["orders.read"]') WHERE id=$1`,
      [connectionId],
    );
    await activate(command, 409);
    await db.owner.query(
      `UPDATE connector_installations SET document=jsonb_set(document,'{granted}','["orders.read","orders.shipping-method.write"]') WHERE id=$1`,
      [connectionId],
    );
    const unsupported = compilePlaybook({
      ...shippingMethodPlaybook,
      version: '0.0.9',
      ir: {
        ...shippingMethodPlaybook.ir,
        action: {
          ...shippingMethodPlaybook.ir.action,
          capabilityVersion: '99',
        },
      },
    });
    await db.owner.query(
      'INSERT INTO playbook_versions(tenant_id,definition_id,version,digest,document) VALUES($1,$2,$3,$4,$5)',
      [
        tenantId,
        unsupported.definition.id,
        unsupported.version,
        unsupported.digest,
        unsupported,
      ],
    );
    await activate(
      {
        ...command,
        version: unsupported.version,
        reviewedDigest: unsupported.digest,
      },
      409,
    );
    const [first, replay] = await Promise.all([activate(), activate()]);
    expect(first.body).toEqual(replay.body);
    expect(first.body.grants).toEqual({
      principalIds: [owner.userId],
      connectionIds: [connectionId],
      targetIds: [targetId],
    });
    expect(first.body.reviewedBy).toBe(owner.userId);
    expect((await read()).body.activations).toHaveLength(1);
    if (transport === 'workflows') {
      expect((await read()).body.summary.readiness).toMatchObject({
        enablement: 'enabled',
        state: 'ready',
        coverage: { unit: 'order', covered: 1, ready: 1 },
      });
      // Losing access keeps the workflow enabled but blocked, with the exact repair.
      await db.owner.query(
        `UPDATE connector_installations SET document=jsonb_set(document,'{granted}','["orders.read"]') WHERE id=$1`,
        [connectionId],
      );
      const blocked = (await read()).body.summary;
      expect(blocked.readiness).toMatchObject({
        enablement: 'enabled',
        state: 'blocked',
        coverage: { covered: 1, ready: 0 },
        nextAction: {
          repair: { destination: 'connections', recordId: connectionId },
        },
      });
      expect(blocked.readiness.issues[0].code).toBe('connection_access');
      await db.owner.query(
        `UPDATE connector_installations SET document=jsonb_set(document,'{granted}','["orders.read","orders.shipping-method.write"]') WHERE id=$1`,
        [connectionId],
      );
    }
    await activate({ ...command, targetIds: [randomUUID()] }, 409);
    await activate({ ...command, id: randomUUID() }, 409);
    const newer = compilePlaybook({
      ...shippingMethodPlaybook,
      version: '0.2.0',
    });
    await db.owner.query(
      'INSERT INTO playbook_versions(tenant_id,definition_id,version,digest,document) VALUES($1,$2,$3,$4,$5)',
      [tenantId, newer.definition.id, newer.version, newer.digest, newer],
    );
    expect((await read()).body.summary.activeVersions).toEqual(['0.1.0']);
    expect((await read()).body.summary.availableVersion).toBe('0.2.0');
    const revoke = () =>
      api.request(`${path}/activations/${command.id}/revoke`, {
        method: 'POST',
        cookie: owner.cookie,
        body: { artifactDigest: first.body.artifactDigest },
      });
    await Promise.all([revoke(), revoke()]);
    expect((await read()).body.activations[0].active).toBe(false);
    expect(
      (
        await db.owner.query(
          'SELECT active FROM action_artifacts WHERE tenant_id=$1',
          [tenantId],
        )
      ).rows[0].active,
    ).toBe(false);
    await activate(command, 409);
    const replacement = await activate({ ...command, id: randomUUID() });
    expect(replacement.body.id).not.toBe(command.id);
    expect((await read()).body.activations).toHaveLength(2);
    await db.owner.query(
      "UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",
      [tenantId, owner.userId],
    );
    await activate({ ...command, id: randomUUID() }, 403);
    await api.request(`${path}/activations/${replacement.body.id}/revoke`, {
      method: 'POST',
      cookie: owner.cookie,
      body: { artifactDigest: replacement.body.artifactDigest },
      status: 403,
    });
    const runId = randomUUID(),
      incidentId = randomUUID();
    const run = {
      id: runId,
      tenantId,
      activationId: replacement.body.id,
      definitionId: version.definition.id,
      version: version.version,
      versionDigest: version.digest,
      action: { id: runId, target: { kind: 'order', id: targetId } },
      principalId: owner.userId,
      diagnosisRevision: 1,
      snapshotDigest: 'a'.repeat(64),
      incidentId,
      createdAt: new Date().toISOString(),
    };
    await db.owner.query(
      'INSERT INTO playbook_runs(tenant_id,id,activation_id,definition_id,version,version_digest,document) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        tenantId,
        runId,
        replacement.body.id,
        version.definition.id,
        version.version,
        version.digest,
        run,
      ],
    );
    await db.owner.query(
      'INSERT INTO playbook_outcomes(tenant_id,run_id,digest,document) VALUES($1,$2,$3,$4)',
      [
        tenantId,
        runId,
        'b'.repeat(64),
        {
          proposalId: runId,
          state: 'escalated',
          reason: 'verification_inconclusive',
          stepId: 'verify-correction',
          execution: {
            state: 'succeeded',
            record: { attempt: { verification: { outcome: 'inconclusive' } } },
          },
        },
      ],
    );
    expect((await read('/runs')).body.items).toEqual([
      expect.objectContaining({
        id: runId,
        ...(transport === 'workflows'
          ? {
              resolution: { incidentId, diagnosisRevision: 1 },
              actor: { kind: 'user', id: owner.userId },
              subject: { kind: 'order', id: targetId },
              story: {
                context:
                  'Diagnosis revision 1. Open the issue to inspect the investigation evidence.',
                decision:
                  'The result could not be confirmed. Operator review is required.',
                action: 'Set the order shipping method to the mapped method.',
                verification: 'The expected correction could not be confirmed.',
              },
            }
          : { incidentId }),
        activationId: replacement.body.id,
        versionDigest: version.digest,
        evidenceKind: 'pilot',
        execution: 'succeeded',
        verification: 'inconclusive',
      }),
    ]);
    for (const [index, reason] of [
      'verification_window_exceeded',
      'verification_inconclusive',
    ].entries()) {
      await db.owner.query(
        'INSERT INTO playbook_outcomes(tenant_id,run_id,digest,document) VALUES($1,$2,$3,$4)',
        [
          tenantId,
          runId,
          String(index + 1).repeat(64),
          {
            proposalId: runId,
            state: 'escalated',
            reason,
            stepId: 'verify-correction',
            execution: {
              state: 'succeeded',
              record: { attempt: { verification: { outcome: 'passed' } } },
            },
          },
        ],
      );
      expect((await read('/runs')).body.items[0]).toMatchObject({
        execution: 'succeeded',
        verification: 'inconclusive',
        reason,
      });
    }
    await api.request(`${path}/runs`, { cookie: outsider.cookie, status: 404 });
    expect(
      (
        await db.owner.query(
          'SELECT count(*)::int AS n FROM playbook_activation_reviews',
        )
      ).rows[0].n,
    ).toBe(2);
  });
}
