import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { DataRegion } from '../domain/context.js';
import { clientAddressHeader } from '../domain/sign-in-protection.js';

// Organization endpoints go through the typed API and scoped identity transactions.
const endpoints = new Set([
  'POST /sign-up/email',
  'POST /sign-in/email',
  'POST /send-verification-email',
  'GET /verify-email',
  'POST /sign-out',
  'GET /get-session',
  'POST /revoke-session-by-id',
  'POST /revoke-sessions',
  'POST /revoke-other-sessions',
  'GET /list-sessions',
  'POST /change-password',
  'POST /request-password-reset',
  'POST /reset-password',
  'POST /two-factor/enable',
  'POST /two-factor/disable',
  'POST /two-factor/verify-totp',
  'POST /two-factor/verify-backup-code',
  'POST /two-factor/generate-backup-codes',
  'GET /passkey/generate-register-options',
  'POST /passkey/verify-registration',
  'GET /passkey/generate-authenticate-options',
  'POST /passkey/verify-authentication',
  'GET /passkey/list-user-passkeys',
  'POST /passkey/delete-passkey',
]);

/**
 * Returns the client address rate limits and security events use. With `header`, the address
 * is the last entry of that header, which the proxy in front of the API appends or overwrites;
 * earlier entries are client-supplied. Without it, or when the header is missing, it is the
 * socket address Fastify reports.
 */
function clientAddress(request: FastifyRequest, header?: string) {
  const value = header ? request.headers[header] : undefined;
  const last = (Array.isArray(value) ? value.at(-1) : value)
    ?.split(',')
    .at(-1)
    ?.trim();

  return last || request.ip;
}

/**
 * Registers the authentication handler on Fastify, forwarding request bodies and response
 * cookies. The client address comes from the socket or, when `clientIpHeader` is set, from the
 * header the deployment's proxy sets; a client can't supply it directly.
 */
export function registerAuthHandler(
  app: FastifyInstance,
  handler: (request: Request) => Promise<Response>,
  baseURL: string,
  regionConfig?: {
    region: DataRegion;
    enabledRegions: readonly DataRegion[];
    regionalOrigins: Partial<Record<DataRegion, string>>;
  },
  clientIpHeader?: string,
) {
  if (regionConfig)
    app.get('/auth/region-config', async (_request, reply) =>
      reply.header('cache-control', 'no-store').send(regionConfig),
    );
  app.route({
    method: ['GET', 'POST'],
    url: '/auth/*',
    async handler(request, reply) {
      const url = new URL(request.url, baseURL);
      if (
        !endpoints.has(
          `${request.method} ${url.pathname.slice('/auth'.length)}`,
        )
      )
        return reply.status(404).send({
          code: 'NOT_FOUND',
          message: 'Route not found',
          requestId: request.id,
        });
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      // Security events cite the server request ID; a caller-supplied value is replaced.
      headers.set('x-luma-request-id', request.id);
      headers.set(clientAddressHeader, clientAddress(request, clientIpHeader));
      const response = await handler(
        new Request(url, {
          method: request.method,
          headers,
          ...(request.body !== undefined
            ? { body: JSON.stringify(request.body) }
            : {}),
        }),
      );
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);

      return reply.send(await response.text());
    },
  });
}
