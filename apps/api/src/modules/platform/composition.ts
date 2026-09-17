export { createObservability } from './infrastructure/observability.js';
export { createTenantDatabase } from './infrastructure/database.js';

import type { Observability } from './application/observability.js';
import { createRoutedModelGateway } from './application/model-gateway.js';
import type {
  ModelAdapter,
  ModelAdapterId,
  ModelRoutingPolicy,
  ModelRoute,
} from './application/model-gateway.js';
import { createVercelModelAdapter } from './infrastructure/vercel-model-adapter.js';

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
