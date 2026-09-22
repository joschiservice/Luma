import {
  readApiConfig,
  readConnectionsConfig,
  readIdentityConfig,
  readModelGatewayConfig,
  readObservabilityConfig,
  readWorkflowConfig,
} from '@luma/config';

import { buildRuntimeApp, createDefaultExceptionWorker } from '#app';
import {
  createObservability,
  type startLocalTelemetry,
} from '#modules/platform/composition';

/** Starts the API or worker and closes local telemetry with its owning runtime. */
export async function main(
  localTelemetry?: Awaited<ReturnType<typeof startLocalTelemetry>>,
) {
  const workflowConfig = () => {
    const config = readWorkflowConfig(process.env);

    return {
      ...config,
      temporal: { ...config.temporal, telemetry: localTelemetry },
    };
  };
  if (process.argv.includes('--workflow-worker')) {
    const worker = await createDefaultExceptionWorker(
      readIdentityConfig(process.env),
      workflowConfig(),
    );
    const shutdown = () => worker.shutdown();
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, shutdown);
    try {
      await worker.run();
    } finally {
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.removeListener(signal, shutdown);
      try {
        await worker.close();
      } finally {
        await localTelemetry?.shutdown();
      }
    }
  } else {
    const config = readApiConfig(process.env);
    const identityConfig = readIdentityConfig(process.env);
    const modelSettings = readModelGatewayConfig(process.env);
    const observability = createObservability({
      ...readObservabilityConfig(process.env),
      approvedModels: Object.values(modelSettings.routes).map(
        (route) => route.model,
      ),
    });
    const app = buildRuntimeApp(
      identityConfig,
      {
        logger: {
          level: config.logLevel,
          redact: [
            'req.headers.cookie',
            'req.headers.authorization',
            'res.headers.set-cookie',
          ],
        },
      },
      observability,
      modelSettings,
      readConnectionsConfig(process.env),
      process.env.WORKFLOW_DATABASE_URL ? workflowConfig() : undefined,
    );

    app.addHook('onClose', async () => {
      await localTelemetry?.shutdown();
    });

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void app.close().catch(() => {
          app.log.error('Shutdown failed');
          process.exitCode = 1;
        });
      });
    }

    try {
      const address = await app.listen({
        host: config.host,
        port: config.port,
      });
      // Supervisors can discover an ephemeral listener without reserving its port.
      process.send?.({ type: 'listening', address });
      process.channel?.unref();
    } catch {
      app.log.error('API startup failed');
      await app.close();
      process.exitCode = 1;
    }
  }
}
