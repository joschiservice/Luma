import { z } from 'zod';

import { ConnectorError } from '#modules/connectors/domain/capabilities';
import type { InstalledConnection } from '#modules/connectors/domain/installation';

/** Selects a trusted transport per installed connection; undefined retains production routing. */
export type SimulationTransport = (
  connection: InstalledConnection,
) => typeof fetch | undefined;

const bindingSchema = z.object({
  tenantId: z.string().uuid(),
  connectionId: z.string().uuid(),
  runId: z.string().regex(/^[a-z0-9-]{1,64}$/),
  instance: z.enum(['jtl', 'shopify']),
  target: z.unknown(),
});
const configSchema = z.object({
  endpoint: z.string().url(),
  token: z.string().min(20),
  bindings: z.array(bindingSchema),
});

/** Rejects unbound synthetic installations before any provider transport can be selected. */
export function simulationTransport(
  connection: InstalledConnection,
  select?: SimulationTransport,
) {
  const transport = select?.(connection);
  const marked =
    connection.label.startsWith('SIMULATED ') ||
    (connection.target.kind === 'jtl-onprem' &&
      new URL(connection.target.baseUrl).hostname.endsWith('.invalid')) ||
    (connection.target.kind === 'shopify' &&
      connection.target.shop.startsWith('luma-synthetic-'));
  if (marked && !transport)
    throw new ConnectorError({
      code: 'unavailable',
      effect: 'none',
      retry: 'never',
    });

  return transport;
}

/** Creates local-only routing from a trusted manifest. Tenant, connection and target must all match. */
export function createSimulationTransport(input: unknown): SimulationTransport {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Simulation transport is unavailable in production');
  const config = configSchema.parse(input);
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw new Error('Simulator endpoint must be a loopback HTTP origin');
  const keys = config.bindings.map((b) => `${b.tenantId}/${b.connectionId}`);
  if (new Set(keys).size !== keys.length)
    throw new Error('Duplicate simulation binding');

  return (connection) => {
    const binding = config.bindings.find(
      (b) =>
        b.tenantId === connection.tenantId && b.connectionId === connection.id,
    );
    if (!binding) return undefined;
    const target = z.record(z.unknown()).parse(binding.target);
    if (
      JSON.stringify(Object.entries(target).sort()) !==
        JSON.stringify(Object.entries(connection.target).sort()) ||
      binding.instance !==
        (connection.target.kind === 'shopify' ? 'shopify' : 'jtl')
    )
      throw new Error('Simulation target does not match installation');

    return async (input, init) => {
      const request = new Request(input, init);
      request.signal.throwIfAborted();
      const response = await fetch(
        new URL(
          `/api/runs/${binding.runId}/providers/${binding.instance}/request`,
          endpoint,
        ),
        {
          method: 'POST',
          redirect: 'error',
          signal: request.signal,
          headers: {
            authorization: `Bearer ${config.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            url: request.url,
            method: request.method,
            headers: Object.fromEntries(request.headers),
            body: request.body ? await request.text() : null,
          }),
        },
      );
      if (!response.ok) throw new Error('Simulator unavailable');
      const result = z
        .object({
          status: z.number().int().min(200).max(599),
          headers: z.record(z.string()),
          body: z.unknown(),
          lost: z.boolean().optional(),
        })
        .parse(await response.json());
      if (result.lost)
        throw new TypeError('Simulated response lost after commit');

      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: result.headers,
      });
    };
  };
}
