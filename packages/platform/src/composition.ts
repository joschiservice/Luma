import type {
  ModelAdapter,
  ModelAdapterId,
  ModelRoute,
  ModelRoutingPolicy,
} from './application/model-gateway.js';
import { createRoutedModelGateway } from './application/model-gateway.js';
import type { Observability } from './application/observability.js';
import type { BedrockEuSettings } from './infrastructure/bedrock-eu-model-adapter.js';
import { createBedrockEuModelAdapter } from './infrastructure/bedrock-eu-model-adapter.js';
import { createVercelModelAdapter } from './infrastructure/vercel-model-adapter.js';

export { createObservability } from './infrastructure/observability.js';

export { createTenantDatabase } from './infrastructure/database.js';

/**
 * Creates the model gateway from startup configuration. Vercel routes need `apiKey`.
 * `bedrock-eu` routes need `bedrock` settings or an injected EU adapter. A route whose
 * adapter is not installed fails with `adapter_unavailable` and never falls back to another
 * adapter. Throws when the Bedrock region is outside the EU or the adapter does not enforce
 * EU processing.
 */
export function createModelGateway(
  settings: {
    routes: Readonly<Record<string, ModelRoute>>;
    apiKey?: string;
    bedrock?: Pick<BedrockEuSettings, 'region' | 'credentials'>;
    timeoutMs: number;
  },
  observability: Observability,
  dependencies: {
    bedrockEu?: ModelAdapter;
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
  const bedrockEu =
    dependencies.bedrockEu ??
    (settings.bedrock
      ? createBedrockEuModelAdapter(
          { ...settings.bedrock, timeoutMs: settings.timeoutMs },
          dependencies.transport,
        )
      : undefined);
  if (bedrockEu) {
    if (bedrockEu.region !== 'EU')
      throw new Error('Bedrock adapter must enforce EU processing');
    adapters['bedrock-eu'] = bedrockEu;
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
