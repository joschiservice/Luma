import type {
  DataRegion,
  ModelAdapter,
  ModelAdapterId,
  ModelRoute,
  ModelRoutingPolicy,
} from './application/model-gateway.js';
import { createRoutedModelGateway } from './application/model-gateway.js';
import type { Observability } from './application/observability.js';
import type { BedrockSettings } from './infrastructure/bedrock-model-adapter.js';
import { createBedrockModelAdapter } from './infrastructure/bedrock-model-adapter.js';
import { createVercelModelAdapter } from './infrastructure/vercel-model-adapter.js';

export { createObservability } from './infrastructure/observability.js';

export { createTenantDatabase } from './infrastructure/database.js';

export { createDatabasePool } from './infrastructure/database-pool.js';

/**
 * Creates the model gateway from startup configuration. Vercel routes need `apiKey`.
 * `bedrock` routes need `bedrock` settings or an injected regional adapter. A route whose
 * adapter is not installed fails with `adapter_unavailable` and never falls back to another
 * adapter. Throws when the Bedrock region is outside the cell jurisdiction or the adapter does not enforce
 * cell processing.
 */
export function createModelGateway(
  settings: {
    dataRegion?: DataRegion;
    routes: Readonly<Record<string, ModelRoute>>;
    apiKey?: string;
    bedrock?: Pick<BedrockSettings, 'region' | 'credentials' | 'dataRegion'>;
    timeoutMs: number;
  },
  observability: Observability,
  dependencies: {
    bedrock?: ModelAdapter;
    routingPolicy?: ModelRoutingPolicy;
    transport?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const adapters: Partial<Record<ModelAdapterId, ModelAdapter>> = {};
  if (settings.apiKey)
    adapters.vercel = createVercelModelAdapter(
      { apiKey: settings.apiKey, timeoutMs: settings.timeoutMs },
      dependencies.transport,
    );
  const bedrock =
    dependencies.bedrock ??
    (settings.bedrock
      ? createBedrockModelAdapter(
          {
            ...settings.bedrock,
            ...(settings.dataRegion ? { dataRegion: settings.dataRegion } : {}),
            timeoutMs: settings.timeoutMs,
          },
          dependencies.transport,
        )
      : undefined);
  if (bedrock) {
    if (
      bedrock.region === 'unrestricted' ||
      (settings.dataRegion && bedrock.region !== settings.dataRegion)
    )
      throw new Error('Bedrock adapter must enforce the cell jurisdiction');
    adapters['bedrock'] = bedrock;
  }

  return createRoutedModelGateway(
    settings.routes,
    adapters,
    observability,
    dependencies.now ?? (() => performance.now()),
    dependencies.routingPolicy,
  );
}

export { startLocalTelemetry } from './infrastructure/local-telemetry.js';

export { createValkeyStore } from './infrastructure/valkey.js';

export { createKmsDataKeyService } from './infrastructure/kms-data-key.js';
