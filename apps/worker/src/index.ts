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

import { createHealth, readHealthPort } from './health.js';

/** Runs the durable workflow worker and releases telemetry after shutdown. */
export async function main(
  localTelemetry?: Awaited<ReturnType<typeof startLocalTelemetry>>,
) {
  const health = createHealth(
    readHealthPort(process.env, 'WORKFLOW_WORKER_HEALTH_PORT'),
  );
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
    await health.listen();
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
    const shutdown = () => {
      health.set('stopping');
      worker.shutdown();
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, shutdown);
    try {
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
