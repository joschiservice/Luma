import type {
  ModelAdapter,
  ModelAdapterId,
  ModelRoute,
  ModelRoutingPolicy,
} from '#modules/platform/application/model-gateway';
import { createRoutedModelGateway } from '#modules/platform/application/model-gateway';
import type { Observability } from '#modules/platform/application/observability';
import { createVercelModelAdapter } from '#modules/platform/infrastructure/vercel-model-adapter';

export { createObservability } from '#modules/platform/infrastructure/observability';

export { createTenantDatabase } from '#modules/platform/infrastructure/database';

/** Bedrock requires an explicitly installed EU adapter; it never falls back to Vercel. */
export function createModelGateway(
  settings: {
    routes: Readonly<Record<string, ModelRoute>>;
    apiKey?: string;
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
  if (dependencies.bedrockEu) {
    if (dependencies.bedrockEu.region !== 'EU')
      throw new Error('Bedrock adapter must enforce EU processing');
    adapters['bedrock-eu'] = dependencies.bedrockEu;
  }

  return createRoutedModelGateway(
    settings.routes,
    adapters,
    observability,
    dependencies.now ?? (() => performance.now()),
    dependencies.routingPolicy,
  );
}
