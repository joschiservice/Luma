import type { ProviderSimulator } from '@luma/simulator-core';

import { command } from './commands.js';
import { drift, handle, rateLimit, unauthorized } from './http.js';
import { identify } from './operation.js';
import type {
  ShopifyCommand,
  ShopifyCommandResult,
  ShopifyConfig,
} from './types.js';

export { rateLimit } from './http.js';

export { readOrder, readStock, type ShopifyOrderView } from './read.js';

export * from './types.js';

/**
 * Simulated Shopify Admin GraphQL API 2026-07 for one shop. Records live in the host's record
 * store; commands apply merchant, customer and integration actions with Shopify's lifecycle
 * rules and webhooks.
 */
export const shopify: ProviderSimulator<
  ShopifyConfig,
  ShopifyCommand,
  ShopifyCommandResult
> = {
  kind: 'shopify',
  table: 'sim_shopify_records',
  identify,
  handle,
  command,
  unauthorized,
  drift,
  rateLimit,
};
