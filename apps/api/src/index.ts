import { buildRuntimeApp } from '@luma/application-runtime';
import {
  readApiConfig,
  readConnectionsConfig,
  readIdentityConfig,
  readModelGatewayConfig,
  readObservabilityConfig,
  readTemporalConfig,
} from '@luma/config';
import { createFailureLog, logStaticFeatureFlags } from '@luma/platform';
import {
  createObservability,
  type startLocalTelemetry,
} from '@luma/platform/composition';

/** Starts the API and closes local telemetry with its owning runtime. */
export async function main(
  localTelemetry?: Awaited<ReturnType<typeof startLocalTelemetry>>,
) {
  // The API is a Temporal client only; the worker's database login stays with the worker.
  const workflowConfig = () => ({
    temporal: {
      ...readTemporalConfig(process.env),
      ...(localTelemetry ? { telemetry: localTelemetry } : {}),
    },
  });
  const config = readApiConfig(process.env);
  const identityConfig = readIdentityConfig(process.env);
  const modelSettings = readModelGatewayConfig(process.env);
  const observabilityConfig = readObservabilityConfig(process.env);
  const observability = createObservability({
    ...observabilityConfig,
    approvedModels: Object.values(modelSettings.routes).map(
      (route) => route.model,
    ),
  });
  const log = createFailureLog(observability);

  const app = await buildRuntimeApp(
    { ...identityConfig, databasePoolMax: config.databasePoolMax },
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
    process.env.TEMPORAL_ADDRESS ? workflowConfig() : undefined,
  );

  app.addHook('onClose', async () => {
    await localTelemetry?.shutdown();
  });
  logStaticFeatureFlags(
    observabilityConfig.staticFeatureFlags,
    (message, fields) => app.log.info(fields, message),
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch((error: unknown) => {
        log('API shutdown failed', error);
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
  } catch (error) {
    // Report before close, which shuts observability down.
    log('API startup failed', error);
    await app.close();
    process.exitCode = 1;
  }
}
