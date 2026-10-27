import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRuntimeApp } from '@luma/application-runtime';
import { test } from 'vitest';

import { performanceReport } from '../../../tooling/performance/report.mjs';
import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

const rounds = 5;
const concurrency = 10;
// A plan list holds at most 100 plans; each one reads its policy decision.
const plans = 100;
// Each direction of the API's database connection is delayed, as for a database a few
// milliseconds away; a local container hides how long a pool connection stays busy.
const delayMs = 5;

/** Starts a TCP proxy to `target` that delays every chunk in both directions. */
async function delayedProxy(t, target) {
  const sockets = new Set();
  const forward = (from, to) =>
    from.on('data', (chunk) => {
      setTimeout(() => to.writable && to.write(chunk), delayMs);
    });
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
      socket.on('close', () => {
        sockets.delete(socket);
        setTimeout(
          () => (socket === client ? upstream : client).end(),
          delayMs,
        );
      });
    }
    forward(client, upstream);
    forward(upstream, client);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  return server.address().port;
}

/** Returns the smallest value at or above `share` of the sorted samples. */
const percentile = (samples, share) =>
  [...samples].sort((a, b) => a - b)[Math.ceil(share * samples.length) - 1];

/**
 * Seeds a workspace with orders and a full purchasing plan list, then builds an API whose
 * database connection is delayed. Returns the fixture and the app.
 */
async function delayedWorkspace(t) {
  const f = await settingsFixture(t);
  await fulfillmentFixture(t, f);
  const supplierId = randomUUID();
  await f.db.owner.query(
    'INSERT INTO procurement_suppliers(tenant_id,id,document) VALUES($1,$2,$3)',
    [
      f.org.id,
      supplierId,
      { tenantId: f.org.id, id: supplierId, name: 'Load supplier' },
    ],
  );
  const now = Date.now();
  for (let index = 0; index < plans; index++) {
    const id = randomUUID();
    const line = { skuId: randomUUID(), locationId: randomUUID() };
    await f.db.owner.query(
      'INSERT INTO procurement_purchasing_plans(tenant_id,id,supplier_id,document,digest,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [
        f.org.id,
        id,
        supplierId,
        {
          id,
          tenantId: f.org.id,
          supplierId,
          requestedBy: f.member.id,
          createdAt: new Date(now - index * 1000).toISOString(),
          expiresAt: new Date(now + 86_400_000).toISOString(),
          request: {
            id,
            supplierId,
            reference: `PLAN-${index}`,
            lines: [{ ...line, quantity: 1, termsRevision: 1 }],
            reason: 'Load',
          },
          order: {
            id: randomUUID(),
            supplierId,
            reference: `PLAN-${index}`,
            authority: 'luma',
            externalReferences: [],
            origin: {},
            lines: [
              {
                id: randomUUID(),
                sku: `SKU-${index}`,
                description: 'Load item',
                quantity: 1,
                locationId: line.locationId,
                unit: 'each',
              },
            ],
          },
          suggestions: [],
          decisionId: randomUUID(),
          state: 'approval_required',
          failure: null,
          actionId: randomUUID(),
        },
        `digest-${index}`,
        new Date(now - index * 1000).toISOString(),
      ],
    );
  }
  const url = new URL(f.config.databaseUrl);
  url.hostname = '127.0.0.1';
  url.port = String(await delayedProxy(t, new URL(f.config.databaseUrl)));
  const app = await buildRuntimeApp({
    ...f.config,
    databaseUrl: url.toString(),
  });
  t.onTestFinished(() => app.close());

  return { f, app };
}

test('serves concurrent Needs-you and order-list reads from one API without exhausting its pool', async (t) => {
  const { f, app } = await delayedWorkspace(t);
  const read = async (path) => {
    const start = performance.now();
    const response = await app.inject({
      method: 'GET',
      url: `${f.base}${path}`,
      headers: { cookie: f.owner.cookie },
    });

    return {
      status: response.statusCode,
      ms: performance.now() - start,
      body: response.statusCode === 200 ? response.json() : null,
    };
  };
  // Warm caches and connections before measuring.
  assert.equal((await read('/decisions')).status, 200);
  assert.equal((await read('/orders')).status, 200);
  const procurement = (await read('/procurement/purchasing/plans')).body;
  assert.equal(procurement.items.length, plans);

  const decisions = [];
  const orders = [];
  const failures = [];
  for (let round = 0; round < rounds; round++) {
    const results = await Promise.all([
      ...Array.from({ length: concurrency }, () => read('/decisions')),
      ...Array.from({ length: concurrency }, () => read('/orders')),
    ]);
    results.forEach((result, index) => {
      (index < concurrency ? decisions : orders).push(result.ms);
      if (result.status !== 200) failures.push(result.status);
    });
  }

  await performanceReport(
    'request-pool',
    {
      requests: decisions.length + orders.length,
      purchasingPlans: plans,
      databaseDelayMs: delayMs,
      failedRequests: failures.length,
      decisionsP95Ms: Math.round(percentile(decisions, 0.95)),
      ordersP95Ms: Math.round(percentile(orders, 0.95)),
    },
    { failedRequests: 0, decisionsP95Ms: 2000, ordersP95Ms: 2000 },
  );
  assert.deepEqual(failures, []);
});

// k6 drives many members over real HTTP connections for half a minute, which the in-process
// rounds above do not. Set LUMA_K6 to the k6 binary (for example `k6`) to run it.
test.skipIf(!process.env.LUMA_K6)(
  'serves Needs-you and order-list reads to concurrent HTTP clients without failures',
  async (t) => {
    const { f, app } = await delayedWorkspace(t);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const directory = await mkdtemp(join(tmpdir(), 'luma-k6-'));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const summary = join(directory, 'summary.json');
    const k6 = spawn(
      process.env.LUMA_K6,
      [
        'run',
        '--quiet',
        '--no-usage-report',
        fileURLToPath(
          new URL(
            '../../../tooling/performance/request-pool.k6.js',
            import.meta.url,
          ),
        ),
      ],
      {
        env: {
          ...process.env,
          BASE_URL: `${origin}${f.base}`,
          COOKIE: f.owner.cookie,
          SUMMARY: summary,
        },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    const [code] = await once(k6, 'exit');
    const { metrics } = JSON.parse(await readFile(summary, 'utf8'));
    const p95 = (name) => Math.round(metrics[name]?.values['p(95)'] ?? -1);

    await performanceReport(
      'request-pool-http',
      {
        requests: metrics.http_reqs.values.count,
        purchasingPlans: plans,
        databaseDelayMs: delayMs,
        failedRequests: metrics.http_req_failed.values.passes,
        decisionsP95Ms: p95('http_req_duration{read:decisions}'),
        ordersP95Ms: p95('http_req_duration{read:orders}'),
      },
      { failedRequests: 0, decisionsP95Ms: 2000, ordersP95Ms: 2000 },
    );
    // k6 exits 99 when a threshold fails; any other failure is a broken run.
    assert.equal(code, 0, `k6 exited with ${code}`);
  },
  120_000,
);
