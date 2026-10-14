import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { chaosPresets } from '@luma/simulator-core';
import { expect, test } from 'vitest';

import { performanceReport } from '../../../tooling/performance/report.mjs';
import { startProcess } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

test('live investigation and governed recovery stay responsive alongside two importing processes', async (t) => {
  const f = await setupSimulator(t, {
    chaos: {
      ...chaosPresets.calm,
      transport: {
        ...chaosPresets.calm.transport,
        rateLimits: true,
        latency: { medianMs: 20, p99Ms: 40 },
      },
    },
  });
  const base = `/v1/organizations/${f.manifest.organizationId}`;
  const login = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { email: 'pilot-operator@example.test', password: f.password },
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const approverLogin = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { email: 'pilot-requester@example.test', password: f.password },
  });
  expect(approverLogin.statusCode).toBe(200);
  const approverCookie = approverLogin.cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const request = async (path, payload, session = cookie) => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: `${base}${path}`,
      headers: { cookie: session, origin: 'http://127.0.0.1:3000' },
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);

    return response.json();
  };
  const orderId = 'gid://shopify/Order/1';
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'shopify',
    command: { kind: 'hold', order: '1', reason: 'HIGH_RISK_OF_FRAUD' },
  });
  for (let index = 0; index < 30; index++)
    await f.call('runs/operations/control', {
      action: 'order',
      lines: [{ sku: 'LUMA-001', quantity: 1 }],
    });
  await f.call('runs/operations/control', {
    action: 'advance',
    milliseconds: 60000,
  });

  const works = await f.call(
    'runs/operations/records/shopify?kind=FulfillmentOrder&limit=100',
  );
  const work = works.items.find((item) => item.data.order === '1');
  expect(work).toBeDefined();
  const target = {
    connectionId: f.manifest.connections.shopify,
    orderId,
    fulfillmentOrderId: `gid://shopify/FulfillmentOrder/${work.id}`,
  };
  const inspect = await request(
    '/apps/shopify/fulfillment-recovery-inspect',
    target,
  );
  const snapshot = inspect.snapshot;
  const preview = await request('/apps/shopify/fulfillment-recovery-preview', {
    ...target,
    requestId: randomUUID(),
    choice: {
      capability: 'fulfillment.hold.release',
      holdId: snapshot.holds[0].id,
    },
  });
  expect(preview.state).toBe('approval_required');
  await request(
    '/apps/shopify/fulfillment-recovery-approve',
    {
      id: preview.id,
      outcome: 'approved',
    },
    approverCookie,
  );

  const importCount = async () =>
    (
      await f.db.owner.query(
        'SELECT COALESCE(sum(r.records),0)::int AS records FROM commerce_sync_runs r JOIN commerce_sync_streams s ON s.id=r.stream_id AND s.tenant_id=r.tenant_id WHERE s.tenant_id=$1 AND s.connection_id=$2',
        [f.manifest.organizationId, target.connectionId],
      )
    ).rows[0].records;
  const initialImported = await importCount();
  const workers = Array.from({ length: 2 }, () =>
    startProcess(
      t,
      fileURLToPath(new URL('./shopify-admission-worker.mjs', import.meta.url)),
      {},
      true,
    ),
  );
  for (const worker of workers) {
    await worker.message('ready');
    worker.child.send(f.purchasingWorkerConfiguration());
  }
  await Promise.all(workers.map((worker) => worker.message('running')));
  const started = performance.now();
  const latencies = [];
  const actionStarted = performance.now();
  const accepted = await request('/apps/shopify/fulfillment-recovery-execute', {
    id: preview.id,
  });
  const actionMs = performance.now() - actionStarted;
  expect(accepted.acceptance).toBe('accepted');
  // Releasing a hold has not established actual fulfillment progress.
  expect(accepted.state).toBe('recovery_required');
  for (let index = 0; index < 10; index++) {
    const at = performance.now();
    const records = await request('/apps/shopify/records', {
      connectionId: target.connectionId,
      kind: 'Order',
    });
    expect(records.sections.some((section) => section.rows.length > 0)).toBe(
      true,
    );
    latencies.push(performance.now() - at);
    // This is the offered workload: one live list per second, in addition to the recovery.
    await delay(Math.max(0, 1000 - (performance.now() - at)));
  }
  for (const worker of workers) worker.child.send('stop');
  await Promise.all(workers.map((worker) => worker.message('stopped')));
  const elapsedSeconds = (performance.now() - started) / 1000;
  const imported = (await importCount()) - initialImported;
  expect(
    imported,
    workers.map((worker) => worker.output).join('\n') +
      JSON.stringify(
        (
          await f.db.owner.query(
            'SELECT record_type,phase,blocked,attempts,error_code,cursor,scan,due_at FROM commerce_sync_streams WHERE tenant_id=$1 AND connection_id=$2',
            [f.manifest.organizationId, target.connectionId],
          )
        ).rows,
      ),
  ).toBeGreaterThan(0);
  const sorted = [...latencies].sort((a, b) => a - b);
  await performanceReport(
    'shopify-admission',
    {
      foregroundP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      actionMs,
      importRecords: imported,
      importRecordsPerSecond: imported / elapsedSeconds,
      importSecondsPerRecord: elapsedSeconds / imported,
      elapsedSeconds,
      workload: {
        seed: 44,
        addedOrders: 30,
        workers: 2,
        foregroundReads: 10,
        foregroundIntervalMs: 1000,
        providerRestoreRate: 100,
        providerLatencyMedianMs: 20,
        providerLatencyP99Ms: 40,
      },
    },
    { foregroundP95Ms: 2000, actionMs: 5000, importSecondsPerRecord: 10 },
  );
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'shopify',
    command: {
      kind: 'fulfill',
      order: '1',
      carrier: 'Synthetic',
      trackingNumber: 'TEST-211',
      trackingUrl: 'https://tracking.example.test/211',
    },
  });
  const verified = await request('/apps/shopify/fulfillment-recovery-check', {
    id: preview.id,
  });
  expect(verified.state).toBe('verified');
  const replay = await request('/apps/shopify/fulfillment-recovery-execute', {
    id: preview.id,
  });
  expect(replay.acceptance).toBe('accepted');
}, 90000);
