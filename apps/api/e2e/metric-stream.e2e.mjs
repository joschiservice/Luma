import { setTimeout as wait } from 'node:timers/promises';

import { buildRuntimeApp } from '@luma/application-runtime';
import { expect, it } from 'vitest';

import { performanceReport } from '../../../tooling/performance/report.mjs';
import { until } from './helpers.mjs';
import { metricStream } from './metric-stream-fixture.mjs';
import { seedMetricOrders } from './metrics-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

it('fans out committed changes, coalesces bursts and recovers listeners, subscriptions and access', async (t) => {
  const f = await settingsFixture(t);
  await f.request(null, `${f.base}/metrics/events`, 'GET', undefined, 401);
  await f.request(
    f.outsider,
    `${f.base}/metrics/events`,
    'GET',
    undefined,
    404,
  );
  const seed = await seedMetricOrders(t, f);
  await seed(0);
  const second = await buildRuntimeApp(f.config);
  t.onTestFinished(() => second.close());
  const a = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const b = await second.listen({ host: '127.0.0.1', port: 0 });
  const streams = await Promise.all([
    metricStream(t, a, f),
    metricStream(t, b, f),
  ]);
  await until(
    () => streams.every((s) => s.events.at(-1).connected),
    'listeners ready',
  );
  const coverage = await f.db.owner.query(
    "SELECT event_object_table, array_agg(event_manipulation::text ORDER BY event_manipulation) AS operations FROM information_schema.triggers WHERE trigger_name='metric_change' GROUP BY event_object_table",
  );
  // pg_trigger is not filtered by the reader's table privileges.
  const triggers = await f.db.owner.query(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE tgnargs=0)::int AS untagged FROM pg_trigger WHERE tgname='metric_change'",
  );
  expect(triggers.rows[0]).toEqual({ total: 64, untagged: 0 });
  expect(coverage.rows.map((row) => row.event_object_table)).toEqual(
    expect.arrayContaining([
      'resolution_measurement_facts',
      'resolution_runs',
      'resolution_learning_events',
      'action_admission_steps',
      'exception_evidence',
      'exception_sources',
      'exception_outbox',
      'case_owners',
      'workflow_events',
      'workflow_human_tasks',
    ]),
  );
  expect(
    coverage.rows.every(
      (row) =>
        JSON.stringify(row.operations) ===
        JSON.stringify(['DELETE', 'INSERT', 'UPDATE']),
    ),
  ).toBe(true);
  const count = () => f.request(f.owner, `${f.base}/metrics/query`, 'POST', {});
  const change = async (status) =>
    f.db.owner.query(
      "UPDATE orders_snapshots SET document=jsonb_set(document,'{data,status}',to_jsonb($2::text)) WHERE tenant_id=$1 AND kind='order'",
      [f.org.id, status],
    );
  // Both completion and reopening use the same canonical update path as corrections.
  for (const [status, expected] of [
    ['completed', 0],
    ['open', 1],
    ['cancelled', 0],
    ['open', 1],
  ]) {
    const before = streams.map((s) => s.events.length);
    await change(status);
    await until(
      () => streams.every((s, i) => s.events.length > before[i]),
      status,
    );
    expect((await count()).metrics[0].observedCount).toBe(expected);
    // An order change names its area and does not wake views of other areas such as Needs you.
    const latest = streams.map((s, i) => s.events.slice(before[i]));
    expect(
      latest.every((events) =>
        events.some(
          (e) => e.topics.includes('orders') && !e.topics.includes('decisions'),
        ),
      ),
    ).toBe(true);
  }
  await wait(120);
  const before = streams.map((s) => s.events.length);
  const tx = await f.db.owner.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(
      "UPDATE orders_snapshots SET document=jsonb_set(document,'{data,status}','\"completed\"') WHERE tenant_id=$1",
      [f.org.id],
    );
    await tx.query('ROLLBACK');
  } finally {
    tx.release();
  }
  await wait(200);
  expect(streams.map((s) => s.events.length)).toEqual(before);
  expect((await count()).metrics[0].observedCount).toBe(1);
  // Reordered and duplicate wake-ups cannot add to or subtract from authoritative totals.
  await Promise.all(
    Array.from({ length: 100 }, () =>
      f.db.owner.query("SELECT pg_notify('luma_metrics',$1)", [f.org.id]),
    ),
  );
  await until(
    () => streams.every((s, i) => s.events.length > before[i]),
    'burst',
  );
  await wait(150);
  const burstInvalidations = streams.map((s, i) => s.events.length - before[i]);
  expect(burstInvalidations.every((count) => count > 0 && count < 10)).toBe(
    true,
  );
  expect((await count()).metrics[0].observedCount).toBe(1);
  const isolated = streams.map((s) => s.events.length);
  await f.db.owner.query(
    "SELECT pg_notify('luma_metrics','00000000-0000-4000-8000-000000000000')",
  );
  await wait(200);
  expect(streams.map((s) => s.events.length)).toEqual(isolated);
  // Kill both process listeners. Each publishes degraded state and reconciles after LISTEN.
  const start = performance.now();
  await f.db.owner.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='luma-metric-listener'",
  );
  await change('completed');
  await until(
    () =>
      streams.every((s) =>
        s.events.slice(isolated[streams.indexOf(s)]).some((e) => !e.connected),
      ),
    'degraded state',
  );
  await until(
    () => streams.every((s) => s.events.at(-1).connected),
    'listener recovery',
  );
  await performanceReport(
    'metric-recovery',
    {
      listenerRecoveryMs: Math.round(performance.now() - start),
      burstInvalidations,
      maxFrameBytes: Math.max(...streams.map((s) => s.maxFrameBytes)),
    },
    { maxFrameBytes: 4096 },
  );
  expect((await count()).metrics[0].observedCount).toBe(0);
  streams[0].close();
  await change('open');
  const reconnected = await metricStream(t, a, f);
  expect(reconnected.events[0].refetch).toBe(true);
  expect((await count()).metrics[0].observedCount).toBe(1);
  await second.close();
  await change('cancelled');
  const restarted = await buildRuntimeApp(f.config);
  t.onTestFinished(() => restarted.close());
  const restartedOrigin = await restarted.listen({
    host: '127.0.0.1',
    port: 0,
  });
  const afterDowntime = await metricStream(t, restartedOrigin, f);
  expect(afterDowntime.events[0].refetch).toBe(true);
  expect((await count()).metrics[0].observedCount).toBe(0);
  await change('open');
  const member = await metricStream(t, restartedOrigin, f, f.member);
  await f.request(
    f.owner,
    `${f.base}/members/${f.membership.id}`,
    'DELETE',
    undefined,
    204,
  );
  await until(() => member.ended, 'revoked stream closes', 7000);
  await f.request(f.member, `${f.base}/metrics/query`, 'POST', {}, 404);
  const session = await metricStream(t, a, f);
  await f.db.owner.query('DELETE FROM sessions WHERE user_id=$1', [f.owner.id]);
  await until(() => session.ended, 'expired session stream closes', 7000);
}, 40000);
