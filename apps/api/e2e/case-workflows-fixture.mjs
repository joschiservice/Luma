import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  createProcessWorker,
  processWorkflowId,
} from '@luma/workflow-temporal';
import { TestWorkflowEnvironment } from '@temporalio/testing';

import { until } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

/**
 * Bound for waits on a workflow run's next state or its Needs you item. Each step runs Temporal
 * activities against PostgreSQL and the simulator, which a fully loaded machine can delay well
 * beyond an idle run; the 60-second journey timeout still bounds the test.
 */
export const workflowWait = 45_000;

/**
 * Runs case workflows against the simulator, PostgreSQL, the HTTP API and a local Temporal
 * server. The operator turns workflows on, so the requester is the different approver.
 * `imported` starts from the simulator's completed initial import, as `setupSimulator` does.
 */
export async function caseWorkflowFixture(
  t,
  {
    origin = 'http://127.0.0.1:3000',
    detection,
    demo,
    observability,
    timeSkipping = false,
    imported = false,
  } = {},
) {
  const temporal = timeSkipping
    ? await TestWorkflowEnvironment.createTimeSkipping()
    : await TestWorkflowEnvironment.createLocal();
  t.onTestFinished(() => temporal.teardown());
  const settings = {
    address: temporal.address,
    namespace: 'default',
    taskQueue: randomUUID(),
    dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
  };
  const f = await setupSimulator(t, {
    imported,
    temporal: settings,
    origin,
    ...(detection ? { detection } : {}),
    ...(demo ? { demo } : {}),
    ...(observability ? { observability } : {}),
  });
  const base = `/v1/organizations/${f.manifest.organizationId}`;
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
      .map((value) => value.split(';')[0])
      .join('; ');
  };
  const operatorCookie = await login('pilot-operator@example.test');
  const approverCookie = await login('pilot-requester@example.test');
  const request = async (
    path,
    body,
    { cookie = operatorCookie, status = 200 } = {},
  ) => {
    const response = await f.pilot.app.inject({
      method: body ? 'POST' : 'GET',
      url: `${base}${path}`,
      headers: { cookie, origin },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(response.statusCode, status, response.body);

    return response.json();
  };
  const actor = await f.pilot.operator();
  // The worker coordinates human tasks and event waits, as the workflow worker does.
  const activities = {
    ...f.pilot.caseWorkflows.activities,
    coordinate: f.pilot.coordination.coordinate,
  };
  let worker = await createProcessWorker(
    { ...settings, taskQueue: `${settings.taskQueue}-procurement` },
    activities,
  );
  let running = worker.run();
  t.onTestFinished(async () => {
    worker.shutdown();
    await running;
    await worker.close();
  });

  /** Turns a workflow on as the operator and returns the activation and its request body. */
  const activate = async (definitionId) => {
    const detail = await request(`/workflows/${definitionId}`);
    const body = {
      id: randomUUID(),
      version: detail.versions[0].version,
      reviewedDigest: detail.versions[0].digest,
      policyVersion: detail.policyVersion,
      scopeReviewed: true,
    };

    return {
      body,
      activation: await request(
        `/workflows/${definitionId}/case-activations`,
        body,
      ),
    };
  };
  const runs = async (definitionId) =>
    (await request(`/workflows/${definitionId}/runs`)).items;
  const waitFor = async (definitionId, runId, states) => {
    let found;
    await until(
      async () => {
        found = (await runs(definitionId)).find((run) => run.id === runId);

        return [states].flat().includes(found?.processState);
      },
      `${definitionId} run ${runId}: ${states}`,
      workflowWait,
    ).catch((error) => {
      throw new Error(
        `${error.message}; last seen ${JSON.stringify(found?.processSteps ?? found)}`,
      );
    });

    return found;
  };
  /** The governed change a waiting action step proposed, from its recorded step evidence. */
  const proposal = (run, stepId) =>
    run.processSteps.find(
      (step) => step.stepId === stepId && step.state === 'waiting',
    )?.values.proposalId;
  const wake = (runId) =>
    temporal.client.workflow
      .getHandle(processWorkflowId(f.manifest.organizationId, runId))
      .signal('processDecisionChanged');

  return {
    ...f,
    temporal,
    /** Replaces only this fixture's worker while preserving Temporal history and storage. */
    restartWorker: async () => {
      worker.shutdown();
      await running;
      await worker.close();
      worker = await createProcessWorker(
        { ...settings, taskQueue: `${settings.taskQueue}-procurement` },
        activities,
      );
      running = worker.run();
    },
    base,
    request,
    actor,
    operatorCookie,
    approverCookie,
    activate,
    runs,
    waitFor,
    proposal,
    wake,
    tick: () => f.pilot.caseWorkflows.tick(actor),
  };
}
