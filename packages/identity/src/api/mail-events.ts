import type { FastifyInstance } from 'fastify';

/**
 * Registers the endpoint Resend calls with delivery events. The handler checks the signature
 * against the raw body, so this route reads the body as text. It answers 204 once an event is
 * recorded or ignored and 401 for an invalid signature, which Resend retries.
 */
export function registerMailEvents(
  app: FastifyInstance,
  receive: (
    payload: string,
    headers: { id: string; timestamp: string; signature: string },
  ) => Promise<void>,
) {
  app.register(async (webhook) => {
    webhook.removeContentTypeParser('application/json');
    webhook.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 262144 },
      (_request, body, done) => done(null, body),
    );
    webhook.post(
      '/v1/email/resend/events',
      { config: { authentication: 'app' } },
      async (request, reply) => {
        const header = (name: string) => {
          const value = request.headers[name];

          return typeof value === 'string' ? value : '';
        };
        await receive(typeof request.body === 'string' ? request.body : '', {
          id: header('svix-id'),
          timestamp: header('svix-timestamp'),
          signature: header('svix-signature'),
        });

        return reply.status(204).send();
      },
    );
  });
}
