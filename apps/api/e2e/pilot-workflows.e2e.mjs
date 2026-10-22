import { expect, onTestFinished, test } from 'vitest';

import {
  respond,
  startJourney,
  waitFor,
} from '../../../tooling/pilot/journey.mjs';
import { operatorRequest, pilotFixture } from './pilot-fixture.mjs';

const { setup } = pilotFixture();

test.each(['approval-required', 'rejected', 'resolved', 'failed'])(
  'real workflow reaches %s through policy and persisted evidence',
  async (scenario) => {
    const t = { onTestFinished };
    const f = await setup(t, scenario);
    const worker = await f.pilot.runtime.createWorker();
    const running = worker.run();
    t.onTestFinished(async () => {
      worker.shutdown();
      await running;
      await worker.close();
    });
    await startJourney(f.pilot, f.manifest, f.client);
    const actor = await f.pilot.context();
    const source = {
      kind: 'incident',
      id: f.manifest.incidents.workflow_failure,
    };
    const phase = {
      'approval-required': 'awaiting_approval',
      rejected: 'denied',
      resolved: 'resolved',
      failed: 'escalated',
    }[scenario];
    await waitFor(
      async () => (await f.client.progress(actor, source))?.phase === phase,
    );
    expect((await f.pilot.provider()).effects).toHaveLength(
      scenario === 'resolved' ? 1 : 0,
    );
    const incident = await f.pilot.detection.exceptions.get(actor, source.id);
    expect(incident.state === 'resolved').toBe(scenario === 'resolved');
    const playbook = await f.pilot.playbooks.get(actor, f.manifest.proposalId);
    expect(playbook.version.provenance.kind).toBe('pilot');
    expect(playbook.run.versionDigest).toBe(playbook.version.digest);
    expect(playbook.run.snapshot.inputs).toEqual({ shippingMethodId: '8' });
    expect(playbook.outcomes.length).toBeGreaterThan(0);
    if (scenario === 'resolved') {
      expect(playbook.outcomes.at(-1)).toMatchObject({
        state: 'verified',
        stepId: 'verify-correction',
      });
      expect(incident.resolution).toMatchObject({
        kind: 'verification',
        outcome: 'passed',
      });
      expect(
        (await f.db.owner.query('SELECT count(*)::int AS n FROM audit_entries'))
          .rows[0].n,
      ).toBeGreaterThan(0);
      // Every read and receipt the correction's attempt cites is stored by the JTL app.
      const evidence = (
        await f.db.owner.query(
          'SELECT id::text,kind,document FROM jtl_shipping_method_evidence WHERE tenant_id=$1',
          [f.manifest.organizationId],
        )
      ).rows;
      const stored = new Map(evidence.map((row) => [row.id, row]));
      const attempts = (
        await f.db.owner.query(
          "SELECT document->'attempt' AS attempt FROM executed_actions WHERE tenant_id=$1",
          [f.manifest.organizationId],
        )
      ).rows.map((row) => row.attempt);
      const receipts = attempts.flatMap((a) => a.effectEvidenceRefs ?? []);
      const reads = attempts.flatMap(
        (a) => a.verification?.observationRefs ?? [],
      );
      expect(receipts.length).toBeGreaterThan(0);
      expect(reads.length).toBeGreaterThan(0);
      for (const ref of receipts)
        expect(stored.get(ref)).toMatchObject({
          kind: 'write_receipt',
          document: {
            adapterVersion: expect.any(String),
            dispatchIdentity: expect.any(String),
            records: [{ resource: 'order', externalId: '10' }],
          },
        });
      for (const ref of reads)
        expect(stored.get(ref)).toMatchObject({
          kind: 'read',
          document: {
            adapterVersion: expect.any(String),
            completeness: 'complete',
          },
        });
    }
    if (scenario === 'approval-required') {
      const review = await f.pilot.desk.review(actor, source.id);
      expect(review.permittedDecisions).not.toContain('approve');
      expect(
        (await f.pilot.desk.review(await f.pilot.operator(), source.id))
          .permittedDecisions,
      ).toContain('approve');
      await respond(f.pilot, f.manifest, f.client, 'reject');
      await waitFor(
        async () =>
          (await f.client.progress(actor, source))?.phase === 'denied',
      );
    }
  },
);

test.each(['executing', 'verifying'])(
  'exposes %s before verified resolution',
  async (scenario) => {
    const t = { onTestFinished };
    const { promise: paused, resolve: release } = Promise.withResolvers();
    const f = await setup(t, scenario, { pause: () => paused });
    const worker = await f.pilot.runtime.createWorker();
    const running = worker.run();
    t.onTestFinished(async () => {
      release();
      worker.shutdown();
      await running;
      await worker.close();
    });
    await startJourney(f.pilot, f.manifest, f.client);
    const actor = await f.pilot.context();
    const source = {
      kind: 'incident',
      id: f.manifest.incidents.workflow_failure,
    };
    await waitFor(
      async () => (await f.client.progress(actor, source))?.phase === scenario,
    );
    expect(
      (await f.pilot.detection.exceptions.get(actor, source.id)).state,
    ).not.toBe('resolved');
    release();
    await waitFor(
      async () =>
        (await f.client.progress(actor, source))?.phase === 'resolved',
    );
    expect((await f.pilot.provider()).patchRequests).toBe(1);
  },
);

test.each(['before', 'after'])(
  'disconnect %s approval prevents fixture dispatch',
  async (timing) => {
    const f = await setup({ onTestFinished }, 'approval-required');
    const worker = await f.pilot.runtime.createWorker();
    const running = worker.run();
    try {
      await startJourney(f.pilot, f.manifest, f.client);
    } finally {
      worker.shutdown();
      await running;
      await worker.close();
    }
    const actor = await f.pilot.context();
    const id = f.manifest.incidents.workflow_failure;
    const proposal = await f.pilot.desk.proposal(actor, f.manifest.proposalId);
    if (timing === 'after')
      await respond(f.pilot, f.manifest, f.client, 'approve');
    const request = await operatorRequest(f);
    const base = `/v1/organizations/${f.manifest.organizationId}`;
    const disconnected = await request(
      `${base}/connections/${f.manifest.connections.jtl}/disconnect`,
      { version: 1 },
    );
    expect(disconnected.statusCode).toBe(200);
    const review = await request(`${base}/exceptions/${id}/review`);
    expect(review.statusCode).toBe(200);
    expect(review.json().proposal.available).toBe(false);
    expect(review.json().permittedDecisions).not.toContain('approve');
    if (timing === 'before')
      await expect(
        respond(f.pilot, f.manifest, f.client, 'approve'),
      ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      await f.pilot.safety.execution.execute(actor, {
        runId: proposal.action.id,
        stepId: 'correct-shipping-method',
      }),
    ).toMatchObject({
      state: 'denied',
      decision: { reason: 'capability_unavailable' },
    });
    expect((await f.pilot.provider()).effects).toHaveLength(0);
    expect((await f.pilot.provider()).patchRequests ?? 0).toBe(0);
  },
);
