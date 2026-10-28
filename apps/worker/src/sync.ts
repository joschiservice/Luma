import { createDefaultCommerceSyncWorker } from '@luma/application-runtime/sync';
import {
  readCommerceSyncConfig,
  readModelGatewayConfig,
  readObservabilityConfig,
  readRegionConfig,
} from '@luma/config';
import { logStaticFeatureFlags } from '@luma/platform';
import {
  createObservability,
  type startLocalTelemetry,
} from '@luma/platform/composition';

import { createHealth, readHealthPort } from './health.js';

/** Runs commerce history import and sync until SIGINT or SIGTERM. */
export async function main(
  localTelemetry?: Awaited<ReturnType<typeof startLocalTelemetry>>,
) {
  const health = createHealth(
    readHealthPort(process.env, 'COMMERCE_SYNC_HEALTH_PORT'),
  );
  // Mailbox reading sends documents and supplier messages to the configured EU model routes.
  const modelSettings = readModelGatewayConfig(process.env);
  const observabilityConfig = readObservabilityConfig(process.env);
  const observability = createObservability({
    ...observabilityConfig,
    approvedModels: Object.values(modelSettings.routes).map(
      (route) => route.model,
    ),
  });
  logStaticFeatureFlags(observabilityConfig.staticFeatureFlags);
  try {
    await health.listen();
    const worker = await createDefaultCommerceSyncWorker(
      readRegionConfig(process.env),
      readCommerceSyncConfig(process.env),
      process.env,
      observability,
      modelSettings,
    );
    const shutdown = () => {
      health.set('stopping');
      worker.shutdown();
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, shutdown);
    try {
      // Unhealthy once the sync loop stops making progress, though the process still runs.
      health.watch(() => !worker.stalled());
      health.set('running');
      await worker.run();
    } finally {
      health.set('stopping');
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.removeListener(signal, shutdown);
      await worker.close();
    }
  } finally {
    await health.close();
    await observability.shutdown();
    await localTelemetry?.shutdown();
  }
}
