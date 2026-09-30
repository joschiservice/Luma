import { createDefaultCommerceSyncWorker } from '@luma/application-runtime/sync';
import { readCommerceSyncConfig, readIdentityConfig } from '@luma/config';
import type { startLocalTelemetry } from '@luma/platform/composition';

/** Runs commerce history import and sync until SIGINT or SIGTERM. */
export async function main(
  localTelemetry?: Awaited<ReturnType<typeof startLocalTelemetry>>,
) {
  try {
    const worker = await createDefaultCommerceSyncWorker(
      readIdentityConfig(process.env),
      readCommerceSyncConfig(process.env),
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
    await localTelemetry?.shutdown();
  }
}
