import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

import { compose, environment, state } from '../dev/environment.mjs';

const mode = process.argv[2] ?? 'dev';
assert(
  ['dev', 'pilot', 'simulator'].includes(mode),
  'Expected dev, pilot or simulator',
);
const apiService = mode === 'dev' ? 'luma-api' : 'luma-pilot-api';
const workerService = mode === 'dev' ? 'luma-worker' : 'luma-pilot-worker';
const saved = await state();
const { generated } = await environment(saved);
const grafana = `http://${await compose(saved, ['port', 'grafana', '3000'], true)}`;
const headers = {
  Authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}`,
};

async function query(path, body) {
  const response = await fetch(`${grafana}/api/datasources/proxy/uid/${path}`, {
    headers: { ...headers, 'Content-Type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  assert(response.ok, `Grafana query failed: ${response.status}`);

  return response.json();
}

async function eventually(work) {
  let last;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await work();
    } catch (error) {
      last = error;
    }
    await setTimeout(1000);
  }
  throw last;
}

await eventually(async () => {
  const response = await fetch(`${generated.API_PROXY_TARGET}/ready`, {
    signal: AbortSignal.timeout(5000),
  });
  assert(
    response.ok,
    'Start the selected development command before verification',
  );
  await response.text();
});

let traceId;
for (let i = 0; i < 20; i++) {
  const response = await fetch(
    `${generated.API_PROXY_TARGET}/ready?private=observability-redaction-canary`,
    {
      headers: { 'x-private': 'observability-redaction-canary' },
      signal: AbortSignal.timeout(5000),
    },
  );
  assert(
    response.ok,
    'Start the selected development command before verification',
  );
  traceId = response.headers.get('x-trace-id');
  await response.text();
}
assert.match(traceId, /^[a-f0-9]{32}$/);
await eventually(async () => {
  const data = await query(`tempo/api/traces/${traceId}`);
  assert(!JSON.stringify(data).includes('observability-redaction-canary'));
  const spans = data.batches.flatMap((batch) =>
    batch.scopeSpans.flatMap((scope) => scope.spans),
  );
  const request = spans.find((span) => span.name === 'api.request');
  assert(request, 'Missing API span');
  assert(
    spans.some(
      (span) =>
        span.name === 'db.SELECT' && span.parentSpanId === request.spanId,
    ),
    'Missing query child spans',
  );
  assert(
    spans.some((span) => span.name === 'db.pool.acquire'),
    'Missing pool acquisition spans',
  );
});
await eventually(async () => {
  const result = await query(
    `prometheus/api/v1/query?query=${encodeURIComponent(`luma_operation_duration_seconds_count{service_name="${apiService}",operation="api.request"}`)}`,
  );
  assert(result.data.result.length, 'Missing duration metrics');
});
await eventually(async () => {
  const result = await query(
    `loki/loki/api/v1/query_range?query=${encodeURIComponent(`{service_name="${apiService}"} | trace_id="${traceId}"`)}`,
  );
  assert(result.data.result.length, 'Missing correlated completion log');
});
await eventually(async () => {
  const result = await query(
    'pyroscope/querier.v1.QuerierService/LabelValues',
    { name: 'service_name', start: Date.now() - 300000, end: Date.now() },
  );
  assert(result.names?.includes(apiService), 'Missing API profiles');
  assert(result.names?.includes(workerService), 'Missing worker profiles');
});
await eventually(async () => {
  const result = await query(
    'pyroscope/querier.v1.QuerierService/SelectMergeStacktraces',
    {
      profileTypeID: 'wall:cpu:nanoseconds:wall:nanoseconds',
      labelSelector: `{service_name="${apiService}"}`,
      start: Date.now() - 300000,
      end: Date.now(),
    },
  );
  assert(result.flamegraph?.names?.length > 1, 'Missing CPU stack samples');
});
console.log(
  `Verified traces, database children, pool waits, metrics, logs, and API/worker profiles.\nTrace: ${traceId}\nDashboard: ${grafana}/d/luma-local`,
);

if (mode === 'simulator') {
  const response = await fetch('http://127.0.0.1:5890/api/runs', {
    headers: { Authorization: 'Bearer local-synthetic-simulator-token' },
  });
  assert(response.ok, 'Simulator is unavailable');
  await response.text();
  await eventually(async () => {
    const q =
      '{ resource.service.name = "luma-simulator" && name = "db.SELECT" }';
    const result = await query(
      `tempo/api/search?q=${encodeURIComponent(q)}&start=${Math.floor(Date.now() / 1000) - 120}&end=${Math.floor(Date.now() / 1000)}`,
    );
    assert(result.traces?.length, 'Missing simulator PostgreSQL traces');
  });
  await eventually(async () => {
    const result = await query(
      'pyroscope/querier.v1.QuerierService/LabelValues',
      {
        name: 'service_name',
        start: Date.now() - 120000,
        end: Date.now(),
      },
    );
    assert(
      result.names?.includes('luma-simulator'),
      'Missing simulator profiles',
    );
  });
  console.log('Verified simulator PostgreSQL traces and profiles.');
}
