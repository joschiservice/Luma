import { ConnectorError } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import type { createRecordService } from '../application/records.js';
import { registerRecordRoutes } from './records.js';

it('requires workspace authentication and never caches records or exposes provider errors', async () => {
  const server = Fastify();
  let authorized = false;
  server.addHook('preHandler', async (request) => {
    if (authorized)
      request.tenantContext = { tenantId: 'tenant-a' } as TenantContext;
  });
  server.setErrorHandler((error, _request, reply) => {
    const known = error instanceof IdentityError;

    return reply
      .status(known ? error.statusCode : 500)
      .send({ message: known ? error.message : 'Internal error' });
  });
  const read = vi.fn<ReturnType<typeof createRecordService>>();
  registerRecordRoutes(server, read);
  try {
    const url = '/v1/organizations/tenant-a/apps/shopify/records';
    expect(
      (await server.inject({ method: 'POST', url, payload: {} })).statusCode,
    ).toBe(401);
    expect(read).not.toHaveBeenCalled();
    authorized = true;
    read.mockRejectedValue(
      new ConnectorError({
        code: 'permission_denied',
        effect: 'none',
        retry: 'never',
      }),
    );
    const denied = await server.inject({ method: 'POST', url, payload: {} });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['cache-control']).toBe('no-store');
    read.mockRejectedValue(new Error('private-token'));
    expect(
      (await server.inject({ method: 'POST', url, payload: {} })).body,
    ).not.toContain('private-token');
  } finally {
    await server.close();
  }
});
