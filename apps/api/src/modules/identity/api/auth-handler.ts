import type { FastifyInstance } from 'fastify';

// Organization endpoints go through the typed API and scoped identity transactions.
const endpoints = new Set([
  'POST /sign-up/email',
  'POST /sign-in/email',
  'POST /sign-out',
  'GET /get-session',
  'POST /revoke-session',
  'POST /revoke-sessions',
  'POST /revoke-other-sessions',
  'GET /list-sessions',
  'POST /change-password',
]);

/**
 * Registers the authentication handler on Fastify, forwarding request bodies and response
 * cookies.
 */
export function registerAuthHandler(
  app: FastifyInstance,
  handler: (request: Request) => Promise<Response>,
  baseURL: string,
) {
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
