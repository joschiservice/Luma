import { APIError } from 'better-auth/api';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { StaffRuntime } from '../application/staff.js';
import { StaffError } from '../domain/access.js';
import { registerStaffHttp } from './routes.js';

const origin = 'http://localhost:3000';

function fixture(mode: 'local' | 'google' = 'local') {
  const directory = vi.fn(async () => ({
    usersTruncated: false,
    workspacesTruncated: false,
    users: [],
    workspaces: [],
  }));
  const accountGrant = vi.fn(async () => {
    throw new Error('Unused');
  });
  const account = vi.fn(async () => {
    throw new Error('Unused');
  });
  const staff: StaffRuntime = {
    settings: { publicOrigin: origin, mode },
    service: {
      directory,
      grant: async () => {
        throw new Error('Unused');
      },
      workspace: async () => {
        throw new Error('Unused');
      },
      revoke: async () => {
        throw new Error('Unused');
      },
      accountGrant,
      account,
      accountSecurityEvents: account,
    },
    authHandler: vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: 'sensitive-session-token',
            user: { email: 'private@example.test' },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'set-cookie':
                'staff.session_token=signed; HttpOnly; Path=/; SameSite=Lax',
            },
          },
        ),
    ),
    resolveSession: async (headers, requestId) => {
      if (!headers.get('cookie'))
        throw new StaffError(401, 'Staff sign-in required.');

      return {
        context: {
          userId: 'staff',
          sessionId: 'session',
          sessionCreatedAt: new Date(),
          permissions: ['staff.workspace.inspect'],
          requestId,
        },
        user: { id: 'staff', name: 'Staff', email: 'staff@example.test' },
      };
    },
    checkReadiness: async () => true,
    close: async () => {},
  };
  const app = Fastify();
  registerStaffHttp(app, staff);

  return { app, staff, directory, accountGrant, account };
}

describe('staff HTTP security boundary', () => {
  it('keeps the session token only in the HttpOnly response cookie', async () => {
    const { app } = fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/sign-in/email',
        headers: { origin },
        payload: {
          email: 'staff@example.test',
          password: 'local-password-long-enough',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(response.body).not.toContain('sensitive-session-token');
      expect(JSON.stringify(response.headers['set-cookie'])).toContain(
        'HttpOnly',
      );
    } finally {
      await app.close();
    }
  });
  it('overwrites caller-supplied address and audit attribution headers', async () => {
    const { app, staff } = fixture();
    try {
      await app.inject({
        method: 'POST',
        url: '/auth/sign-in/email',
        headers: {
          origin,
          'x-luma-staff-client-ip': '203.0.113.1',
          'x-forwarded-for': '203.0.113.2',
          'x-real-ip': '203.0.113.3',
          'x-luma-staff-request-id': 'forged-request',
        },
        payload: {
          email: 'staff@example.test',
          password: 'local-password-long-enough',
        },
      });
      const mock = vi.mocked(staff.authHandler);
      const request = mock.mock.calls[0]?.[0];
      expect(request?.headers.get('x-luma-staff-client-ip')).toBe('127.0.0.1');
      expect(request?.headers.get('x-forwarded-for')).toBeNull();
      expect(request?.headers.get('x-real-ip')).toBeNull();
      expect(request?.headers.get('x-luma-staff-request-id')).not.toBe(
        'forged-request',
      );
    } finally {
      await app.close();
    }
  });
  it('denies undeclared routes and enforces permissions before invoking a service', async () => {
    const { app, directory } = fixture();
    app.get('/forgotten-staff-route', async () => ({ secret: 'private' }));
    try {
      expect(
        (
          await app.inject({
            url: '/forgotten-staff-route',
            headers: { cookie: 'staff' },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            url: '/v1/staff/directory?query=customer',
            headers: { cookie: 'staff' },
          })
        ).statusCode,
      ).toBe(403);
      expect(directory).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('requires account inspection permission before account access or reads', async () => {
    const { app, accountGrant, account } = fixture();
    const userId = '6f1f8f5e-6b8a-4c1b-9d55-2f0f6a1b7c3d';
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/staff/accounts/${userId}/access`,
            headers: { cookie: 'staff', origin },
            payload: { reason: 'Investigating a sign-in ticket' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: `/v1/staff/accounts/${userId}?grantId=${userId}`,
            headers: { cookie: 'staff' },
          })
        ).statusCode,
      ).toBe(403);
      expect(accountGrant).not.toHaveBeenCalled();
      expect(account).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('rejects browser-supplied ID tokens and provider/callback overrides', async () => {
    const { app, staff } = fixture('google');
    try {
      for (const payload of [
        { provider: 'google', idToken: { token: 'forged' } },
        { provider: 'untrusted' },
        { provider: 'google', callbackURL: 'https://attacker.example/' },
      ]) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/auth/sign-in/social',
              headers: { origin },
              payload,
            })
          ).statusCode,
        ).toBe(403);
      }
      expect(staff.authHandler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('staff sign-in throttling', () => {
  it.each(['response', 'exception'] as const)(
    'preserves sanitized 429 and Retry-After for a provider %s',
    async (kind) => {
      const { app, staff } = fixture();
      const handler = vi.mocked(staff.authHandler);
      if (kind === 'response')
        handler.mockResolvedValueOnce(
          new Response('private provider diagnostic', {
            status: 429,
            headers: { 'X-Retry-After': '10' },
          }),
        );
      else
        handler.mockRejectedValueOnce(
          new APIError(
            'TOO_MANY_REQUESTS',
            { message: 'private provider diagnostic' },
            { 'X-Retry-After': '10' },
          ),
        );
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/sign-in/email',
          headers: { origin },
          payload: {
            email: 'staff@example.test',
            password: 'local-password-long-enough',
          },
        });
        expect(response.statusCode).toBe(429);
        expect(response.headers['retry-after']).toBe('10');
        expect(response.json()).toMatchObject({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many sign-in attempts. Try again shortly.',
        });
        expect(response.body).not.toContain('private provider diagnostic');
      } finally {
        await app.close();
      }
    },
  );
});
