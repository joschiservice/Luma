/** Provider construction for installed runtimes and synthetic transport fixtures. */
export { createCapabilityRuntime } from './application/capabilities.js';

export { createJtlConnector } from './infrastructure/jtl/adapter.js';

export { createShopifyConnector } from './infrastructure/shopify/adapter.js';

export { simulationTransport } from './infrastructure/installations/simulation.js';
