import { createDefaultExceptionWorker } from '@luma/application-runtime/worker';
import {
  readConnectionsConfig,
  readIdentityConfig,
  readObservabilityConfig,
  readWorkflowConfig,
} from '@luma/config';
import {
  createObservability,
  type startLocalTelemetry,
} from '@luma/platform/composition';

/** Runs the durable workflow worker and releases telemetry after shutdown. */
export async function main(
  localTelemetry?: Awaited<ReturnType<typeof startLocalTelemetry>>,
) {
  const workflowConfig = () => {
    const config = readWorkflowConfig(process.env);

    return {
      ...config,
      temporal: {
        ...config.temporal,
        ...(localTelemetry ? { telemetry: localTelemetry } : {}),
      },
    };
  };
  const observability = createObservability(
    readObservabilityConfig(process.env),
  );
  try {
    const config = workflowConfig();
    const worker = await createDefaultExceptionWorker(
      readIdentityConfig(process.env),
      {
        ...config,
        temporal: {
          ...config.temporal,
          captureActivityError: observability.captureActivityError,
        },
      },
      readConnectionsConfig(process.env),
      process.env,
      observability,
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
