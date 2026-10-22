import { buildRuntimeApp } from '@luma/application-runtime';
import { it } from 'vitest';

import { performanceReport } from '../../../tooling/performance/report.mjs';
import { until } from './helpers.mjs';
import { metricStream } from './metric-stream-fixture.mjs';
import { seedMetricOrders } from './metrics-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

it('measures how long two API processes take to restore live delivery after losing their listeners', async (t) => {
  const f = await settingsFixture(t);
  const seed = await seedMetricOrders(t, f);
  await seed(0);
  const second = await buildRuntimeApp(f.config);
  t.onTestFinished(() => second.close());
  const streams = await Promise.all([
    metricStream(t, await f.app.listen({ host: '127.0.0.1', port: 0 }), f),
    metricStream(t, await second.listen({ host: '127.0.0.1', port: 0 }), f),
  ]);
  await until(
    () => streams.every((s) => s.events.at(-1).connected),
    'listeners ready',
  );
  const marks = streams.map((s) => s.events.length);
  const start = performance.now();
  await f.db.owner.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='luma-metric-listener'",
  );
  await f.db.owner.query(
    "UPDATE orders_snapshots SET document=jsonb_set(document,'{data,status}','\"completed\"') WHERE tenant_id=$1 AND kind='order'",
    [f.org.id],
  );
  await until(
    () =>
      streams.every((s, i) =>
        s.events.slice(marks[i]).some((e) => !e.connected),
      ),
    'degraded state',
  );
  await until(
    () => streams.every((s) => s.events.at(-1).connected),
    'listener recovery',
  );
  await performanceReport('metric-recovery', {
    listenerRecoveryMs: Math.round(performance.now() - start),
  });
});
