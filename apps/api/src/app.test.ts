import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('API bootstrap', () => {
  const app = buildApp();
  afterEach(async () => {
    await app.close();
  });

  it('responds to health checks without external services', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
