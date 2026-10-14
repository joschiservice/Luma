import { randomUUID } from 'node:crypto';

import {
  createInstallationVerifier,
  createShopifyConnector,
} from '@luma/app-shopify';
import { readRegionConfig } from '@luma/config';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { rateLimit } from '@luma/simulator-shopify';

/** Shopify's single-query limit on requested cost. */
export const maxQueryCost = 1000;

/**
 * @typedef {{ capability: string, operation: string, shopify: number | null, simulator: number }} QueryCost
 * @typedef {{ queries: QueryCost[], failures: { capability: string, error: unknown }[], skipped: { capability: string, reason: string }[] }} CostReport
 */

/**
 * Narrows a capability name to a read capability.
 * @param {string} name
 * @returns {name is import('@luma/connections').ReadCapability}
 */
const isRead = (name) => name.endsWith('.read');

/**
 * Verifies the account and token scopes, then reads authorized collection capabilities at
 * the largest sync page. Records Shopify’s requested cost beside the simulator’s estimate.
 * Reports omitted scopes, unapproved customer access and reads requiring an exact target.
 * Reads only; nothing is stored. Nested follow-up queries run only when the shop has records
 * that overflow a first page, so a shop with such records covers more query shapes.
 * @param {{ shop: string, accessToken: string, fetch?: typeof globalThis.fetch, customerAccess?: {contact: boolean, address: boolean} }} options
 * @returns {Promise<CostReport>}
 */
export async function checkReadCosts({
  shop,
  accessToken,
  fetch = globalThis.fetch,
  customerAccess,
}) {
  const tenantId = randomUUID();
  const connectionId = randomUUID();
  /** @type {Map<string, QueryCost>} */
  const queries = new Map();
  let capability = 'installation.verify';
  /**
   * Passes each request through and records its cost once per query shape.
   * @type {typeof globalThis.fetch}
   */
  const recording = async (input, init) => {
    const response = await fetch(input, init);
    const text = typeof init?.body === 'string' ? init.body : null;
    const body = text ? JSON.parse(text) : null;
    if (!text || !body?.query) return response;
    const answer = await response
      .clone()
      .json()
      .catch(() => null);
    const requested = answer?.extensions?.cost?.requestedQueryCost;
    const key = JSON.stringify([body.query, body.variables?.first ?? null]);
    if (!queries.has(key))
      queries.set(key, {
        capability,
        operation: operationOf(body.query),
        shopify: typeof requested === 'number' ? requested : null,
        simulator: rateLimit.cost({
          url: String(input),
          method: 'POST',
          headers: {},
          body: text,
        }),
      });

    return response;
  };
  const granted = await createInstallationVerifier({ fetch: recording })(
    {
      id: connectionId,
      tenantId,
      label: 'Cost check',
      target: { kind: 'shopify', shop },
      permissions: [],
      granted: [],
      status: 'pending',
      version: 0,
      credentialVersion: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    { token: accessToken },
  );
  const connector = createShopifyConnector({
    tenantId,
    connectionId,
    shop,
    accessToken: async () => accessToken,
    fetch: recording,
    ...(customerAccess ? { customerAccess } : {}),
    inventoryShipmentAccess: granted.includes('inventory.shipments.read'),
    recordObservations: async () => {
      // The check keeps no observations.
    },
  });
  const runtime = createCapabilityRuntime({
    resolve: async () => connector,
    record: async () => {
      // The check keeps no read results.
    },
  });
  const tenant = makeTenantContext(
    { userId: 'cost-check', sessionId: 'cost-check' },
    {
      id: tenantId,
      name: 'Cost check',
      slug: 'cost-check',
      status: 'active',
      dataRegion: readRegionConfig(process.env).region,
    },
    builtInMembership(
      { id: 'cost-check', organizationId: tenantId, userId: 'cost-check' },
      'owner',
    ),
    'request',
  );
  const failures = [];
  const skipped = [];
  if (!customerAccess)
    skipped.push({
      capability: 'customers.read',
      reason: 'Protected customer data access was not explicitly approved.',
    });
  for (const name of Object.keys(connector.capabilities).filter(isRead)) {
    if (!granted.includes(name)) {
      skipped.push({
        capability: name,
        reason: 'The verified token does not grant this read capability.',
      });
      continue;
    }
    try {
      connector.capabilities[name]?.parseInput({ limit: 100 });
    } catch {
      skipped.push({
        capability: name,
        reason:
          'This operation requires an exact target; collection input cannot probe it.',
      });
      continue;
    }
    capability = name;
    // 100 is the largest limit a read accepts; adapters bound each root page below it.
    const result = await runtime.read(tenant, {
      connectionId,
      capability: name,
      version: '0',
      input: { limit: 100 },
    });
    if (!result.ok) failures.push({ capability: name, error: result.error });
  }

  return { queries: [...queries.values()], failures, skipped };
}

/**
 * Names a query by its operation and root field, such as `LumaPage orders`.
 * @param {string} query
 */
function operationOf(query) {
  const name = /^\s*query\s+(\w+)/.exec(query)?.[1] ?? 'query';
  const root = /\{\s*(?:\w+:\s*)?(\w+)/.exec(query)?.[1] ?? '';

  return `${name} ${root}`.trim();
}

/**
 * Queries whose Shopify cost exceeds the limit or that the simulator underestimates.
 * @param {CostReport} report
 */
export function costProblems({ queries }) {
  return queries.filter(
    (query) =>
      query.shopify !== null &&
      (query.shopify > maxQueryCost || query.simulator < query.shopify),
  );
}
