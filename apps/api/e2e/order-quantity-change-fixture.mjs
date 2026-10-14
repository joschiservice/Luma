import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';

import { caseWorkflowFixture } from './case-workflows-fixture.mjs';
import { until } from './helpers.mjs';
import {
  linkFixtureOrder,
  packFixtureOrder,
} from './order-change-plan-fixture.mjs';

export const workflow = 'order-quantity-change';

/**
 * Runs the order quantity change against the simulator, PostgreSQL, the HTTP API and a local
 * Temporal worker. Fixture order 1 is linked across Shopify and JTL and accepted into Luma ERP,
 * which holds order-line authority. The operator turns the workflow on, so runs act as the
 * operator; the requester is the different approver and a Member answers warehouse tasks.
 */
export async function quantityChangeFixture(t, options = {}) {
  const f = await caseWorkflowFixture(t, {
    ...options,
    observability: createObservability({
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      featureFlagOverrides: { 'luma-erp-orders': true },
    }),
  });
  const origin = options.origin ?? 'http://127.0.0.1:3000';
  const login = async (email) => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email, password: f.password },
    });
    assert.equal(response.statusCode, 200, response.body);

    return response.cookies
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
  };
  const warehouseCookie = await login('pilot-warehouse@example.test');
  /** Calls the workspace API with any method; operator by default. */
  const api = async (
    method,
    path,
    body,
    { cookie = f.operatorCookie, status = 200 } = {},
  ) => {
    const response = await f.pilot.app.inject({
      method,
      url: `${f.base}${path}`,
      headers: { cookie, origin },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(response.statusCode, status, response.body);

    return response.body ? response.json() : null;
  };
  const operatorApi = (url, options = {}, status = 200) =>
    api(options.method ?? 'GET', url, options.payload, { status });
  const { shop } = await linkFixtureOrder(f, operatorApi);
  const connections = {
    shopify: f.manifest.connections.shopify,
    jtl: f.manifest.connections.jtl,
  };

  // Support accepts the shop order into Luma, which becomes the order-line authority.
  const record = await api('POST', `/sales/orders/${shop}/accept`, {
    connectionId: connections.shopify,
  });
  connections.erp = record.connectionId;
  for (const group of ['order_lifecycle', 'order_lines']) {
    const authority = await api('GET', '/source-authority');
    await api('POST', '/source-authority', {
      commandId: randomUUID(),
      revision: authority.revision,
      group,
      connectionId: connections.erp,
    });
  }
  await f.pilot.observe({ check: false });
  // Luma's record shares the shop's line, so all three sources compare under that line.
  const detail = await api('GET', `/orders/${shop}`);
  const lineKey = detail.sources.find(
    (source) => source.connectionId === connections.shopify,
  )?.lines[0]?.comparisonKey;
  assert.ok(
    lineKey &&
      Object.values(connections).every(
        (connectionId) =>
          detail.sources.find((source) => source.connectionId === connectionId)
            ?.lines[0]?.comparisonKey === lineKey,
      ),
    'the line is matched across Luma ERP, Shopify and JTL',
  );

  return {
    ...f,
    api,
    warehouseCookie,
    shop,
    lineKey,
    connections,
    /** The case opened for the order line, once detection confirmed the difference. */
    async caseOpened() {
      return until(
        async () => {
          await f.pilot.detect();

          return (await f.pilot.detection.exceptions.list(f.actor)).find(
            (item) =>
              item.exceptionClass === 'order_quantity_mismatch' &&
              item.state !== 'resolved',
          );
        },
        `detection opens the quantity case: ${JSON.stringify(f.pilot.detectionErrors)}`,
        30_000,
      );
    },
    /** The customer asks support to change the line; support edits the Luma record. */
    async changeQuantity(quantity) {
      const current = await api('GET', `/sales/orders/${shop}`);
      await api('PATCH', `/sales/orders/${shop}`, {
        commandId: randomUUID(),
        version: current.version,
        lines: [{ id: current.lines[0].id, currentQuantity: quantity }],
      });
    },
    /** The JTL warehouse starts packing the order. */
    packing: () => packFixtureOrder(f, operatorApi, shop),
    /** The JTL warehouse stops packing and removes the delivery note to pick again. */
    async unpack() {
      await f.call('runs/operations/control', {
        action: 'command',
        instance: 'jtl',
        command: { kind: 'unpack', id: '1' },
      });
    },
    /** The workflow's run for the case, once the worker started it. */
    async run() {
      await f.tick();
      const [run] = await until(async () => {
        await f.tick();
        const runs = await f.runs(workflow);

        return runs.length ? runs : null;
      }, 'the workflow starts a run for the case');

      return run;
    },
    task: (runId, cookie = warehouseCookie, status = 200) =>
      api('GET', `/workflows/${workflow}/runs/${runId}/tasks/dispatch`, null, {
        cookie,
        status,
      }),
    /** Answers the warehouse task, then wakes the run. */
    async answer(runId, choice, cookie = warehouseCookie) {
      const answered = await api(
        'POST',
        `/workflows/${workflow}/runs/${runId}/tasks/dispatch/answer`,
        {
          choice,
          note: 'Dispatch updated in JTL.',
          evidence: { kind: 'text', value: 'Pick list adjusted at packing.' },
        },
        { cookie },
      );
      await f.wake(runId);

      return answered;
    },
    /** Approves the run's waiting Shopify edit as the requester, then wakes the run. */
    async approve(runId) {
      const run = await f.waitFor(workflow, runId, 'awaiting_decision');
      const id = f.proposal(run, 'edit-shopify');
      assert.ok(id, 'the edit waits for approval');
      await api(
        'POST',
        '/apps/shopify/order-edit-approve',
        { id, outcome: 'approved' },
        { cookie: f.approverCookie },
      );
      await f.wake(runId);

      return id;
    },
    /**
     * Shopify order edit commits the simulator journal recorded, once it recorded at least one.
     * The journal is written in batches.
     */
    async commits() {
      return until(
        async () => {
          const journal = await f.call(
            `runs/${f.manifest.simulator.runId}/journal`,
          );
          const commits = journal.items.filter(
            (entry) =>
              entry.kind === 'provider-write' &&
              JSON.stringify(entry).includes('orders.quantity.edit'),
          );

          return commits.length ? commits : null;
        },
        'the simulator journals the Shopify edit commit',
        20_000,
      );
    },
  };
}
