import { createDefaultCommerceSyncWorker } from '@luma/application-runtime/sync';
import {
  readCommerceSyncConfig,
  readIdentityConfig,
  readModelGatewayConfig,
  readObservabilityConfig,
} from '@luma/config';
import {
  createObservability,
  type startLocalTelemetry,
} from '@luma/platform/composition';

/** Runs commerce history import and sync until SIGINT or SIGTERM. */
export async function main(
  localTelemetry?: Awaited<ReturnType<typeof startLocalTelemetry>>,
) {
  // Mailbox reading sends documents and supplier messages to the configured EU model routes.
  const modelSettings = readModelGatewayConfig(process.env);
  const observability = createObservability({
    ...readObservabilityConfig(process.env),
    approvedModels: Object.values(modelSettings.routes).map(
      (route) => route.model,
    ),
  });
  try {
    const worker = await createDefaultCommerceSyncWorker(
      readIdentityConfig(process.env),
      readCommerceSyncConfig(process.env),
      process.env,
      observability,
      modelSettings,
    );
    const shutdown = () => worker.shutdown();
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, shutdown);
    try {
      await worker.run();
    } finally {
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.removeListener(signal, shutdown);
      await worker.close();
    }
  } finally {
    await observability.shutdown();
    await localTelemetry?.shutdown();
  }
}
