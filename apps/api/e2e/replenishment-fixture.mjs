import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  createProcessWorker,
  processWorkflowId,
} from '@luma/workflow-temporal';
import { TestWorkflowEnvironment } from '@temporalio/testing';

import { until } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

/** Runs procurement against real simulator observations, PostgreSQL, HTTP policy commands and Temporal. */
export async function replenishmentFixture(
  t,
  origin = 'http://127.0.0.1:3000',
  options = {},
) {
  const temporal = await TestWorkflowEnvironment.createLocal();
  t.onTestFinished(() => temporal.teardown());
  const settings = {
    address: temporal.address,
    namespace: 'default',
    taskQueue: randomUUID(),
    dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
  };
  const f = await setupSimulator(t, { temporal: settings, origin, ...options });
  await f.pilot.observe();
  const root = `/v1/organizations/${f.manifest.organizationId}/workflows/inventory-replenishment`;
  const login = async (email) => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email, password: f.password },
    });
    assert.equal(response.statusCode, 200, response.body);

    return []
      .concat(response.headers['set-cookie'])
      .map((v) => v.split(';')[0])
      .join('; ');
  };
  const ownerCookie = await login('pilot-operator@example.test');
  const approverCookie = await login('pilot-requester@example.test');
  const request = async (
    path,
    body,
    { cookie = ownerCookie, status = 200 } = {},
  ) => {
    const response = await f.pilot.app.inject({
      method: body ? 'POST' : 'GET',
      url: `${root}${path}`,
      headers: { cookie, origin },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(response.statusCode, status, response.body);

    return response.json();
  };
  const actor = await f.pilot.operator();
  const supplier = await f.pilot.procurement.createSupplier(actor, {
    id: randomUUID(),
    name: 'Northstar Supply',
  });
  const setup = await request('/replenishment');
  // Sync imports both fixture SKUs; the scenarios replenish the canvas tote.
  const position = setup.positions.find(
    (p) =>
      p.connectionId === f.manifest.connections.jtl && p.sku === 'LUMA-001',
  );
  assert.ok(position);
  const detail = await request('');
  const configure = async () =>
    request('/replenishment/activations', {
      id: randomUUID(),
      positionId: position.positionId,
      connectionId: position.connectionId,
      supplierId: supplier.id,
      minimum: Math.max(1, position.available + 10),
      target: Math.max(50, position.available + 50),
      approvalQuantity: 20,
      reviewedDigest: detail.versions[0].digest,
    });
  let worker;
  let running;
  let beforeRead = async () => {};
  let beforeVerify = async () => {};
  const startWorker = async () => {
    worker = await createProcessWorker(
      { ...settings, taskQueue: `${settings.taskQueue}-procurement` },
      {
        ...f.pilot.replenishment.activities,
        read: async (...args) => {
          await beforeRead(...args);

          return f.pilot.replenishment.activities.read(...args);
        },
        verify: async (...args) => {
          await beforeVerify(...args);

          return f.pilot.replenishment.activities.verify(...args);
        },
      },
    );
    running = worker.run();
  };
  const stopWorker = async () => {
    if (!worker) return;
    worker.shutdown();
    await running;
    await worker.close();
    worker = null;
  };
  t.onTestFinished(stopWorker);
  await startWorker();
  const runView = async (id) =>
    (await request('/runs')).items.find((r) => r.id === id);
  const waitFor = async (id, state) => {
    await until(
      async () => (await runView(id))?.processState === state,
      `${id}: ${state}`,
      20000,
    );

    return runView(id);
  };
  const decide = async (run, outcome = 'approved') => {
    await waitFor(run.id, 'awaiting_decision');
    const review = await request(`/replenishment/runs/${run.id}`, undefined, {
      cookie: approverCookie,
    });
    assert.equal(review.canRespond, true, JSON.stringify(review));
    await request(
      `/replenishment/runs/${run.id}/decision`,
      { decisionId: review.decisionId, outcome },
      { cookie: approverCookie },
    );
    await temporal.client.workflow
      .getHandle(processWorkflowId(f.manifest.organizationId, run.id))
      .signal('processDecisionChanged');
  };

  return {
    ...f,
    temporal,
    root,
    request,
    actor,
    supplier,
    position,
    configure,
    ownerCookie,
    approverCookie,
    waitFor,
    decide,
    runView,
    stopWorker,
    startWorker,
    setBeforeRead: (fn) => {
      beforeRead = fn;
    },
    setBeforeVerify: (fn) => {
      beforeVerify = fn;
    },
  };
}
