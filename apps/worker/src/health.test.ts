import { describe, expect, it } from 'vitest';

import { createHealth, readHealthPort, startHealthServer } from './health.js';

describe('worker health', () => {
  it('reads an optional port and rejects invalid values', () => {
    expect(readHealthPort({}, 'HEALTH_PORT')).toBeUndefined();
    expect(readHealthPort({ HEALTH_PORT: ' ' }, 'HEALTH_PORT')).toBeUndefined();
    expect(readHealthPort({ HEALTH_PORT: '9464' }, 'HEALTH_PORT')).toBe(9464);
    for (const value of ['0', '65536', '1.5', 'port'])
      expect(() =>
        readHealthPort({ HEALTH_PORT: value }, 'HEALTH_PORT'),
      ).toThrow('HEALTH_PORT must be an integer from 1 to 65535');
  });

  it('reports ready only while the workers are running', async () => {
    const server = await startHealthServer(0);
    const check = async (path = '/health') => {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`);

      return { status: response.status, body: await response.text() };
    };
    try {
      expect(await check()).toEqual({
        status: 503,
        body: '{"state":"starting"}',
      });
      server.set('running');
      expect(await check()).toEqual({
        status: 200,
        body: '{"state":"running"}',
      });
      server.set('stopping');
      expect((await check()).status).toBe(503);
      expect((await check('/other')).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('does nothing without a configured port', async () => {
    const health = createHealth(undefined);
    await health.listen();
    health.set('running');
    await expect(health.close()).resolves.toBeUndefined();
  });
});
