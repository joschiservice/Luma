import Fastify from 'fastify';
import type { FastifyServerOptions } from 'fastify';

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);
  app.get('/health', async () => ({ status: 'ok' as const }));
  return app;
}
