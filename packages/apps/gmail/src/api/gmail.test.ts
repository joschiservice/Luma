import { ServiceError } from '@luma/platform';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { registerGmailRoutes } from './gmail.js';

const tenant = '11111111-1111-4111-8111-111111111111';

function oauth() {
  return {
    config: { webOrigin: 'https://luma.test' },
    callbackTenant: () => tenant,
    callback: vi.fn(async () => 'connected' as const),
  };
}

it('redirects to the settings page with the outcome and never echoes the code', async () => {
  const app = Fastify();
  const service = oauth();
  registerGmailRoutes(
    app,
    service,
    { resolveTenant: vi.fn().mockResolvedValue({ tenantId: tenant }) },
    vi.fn(),
  );
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/gmail/callback?state=${tenant}.x&code=private-code`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      `https://luma.test/app/${tenant}/apps/gmail/settings?appResult=connected`,
    );
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body).not.toContain('private-code');
  } finally {
    await app.close();
  }
});

it('redirects to recovery when the session cannot be resolved', async () => {
  const app = Fastify();
  const service = oauth();
  registerGmailRoutes(
    app,
    service,
    {
      resolveTenant: vi
        .fn()
        .mockRejectedValue(
          new ServiceError(401, 'UNAUTHENTICATED', 'Sign in again'),
        ),
    },
    vi.fn(),
  );
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/gmail/callback?code=private-code',
    });
    expect(response.headers.location).toBe(
      `https://luma.test/app/${tenant}/apps/gmail/settings?appResult=failed`,
    );
    expect(service.callback).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('passes push credentials and body to the intake and acknowledges with 204', async () => {
  const app = Fastify();
  const push = vi.fn(async () => {});
  registerGmailRoutes(app, undefined, undefined, push);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/gmail/push',
      headers: { authorization: 'Bearer token' },
      payload: { message: { data: 'e30=' } },
    });
    expect(response.statusCode).toBe(204);
    expect(push).toHaveBeenCalledWith('Bearer token', {
      message: { data: 'e30=' },
    });
  } finally {
    await app.close();
  }
});
