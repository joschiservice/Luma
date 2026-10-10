import { APIError } from 'better-auth/api';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { StaffRuntime } from '../application/staff.js';
import type { StaffPermission } from '../domain/access.js';
import { StaffError } from '../domain/access.js';
import { registerStaffHttp } from './routes.js';

const origin = 'http://localhost:3000';

function fixture(
  mode: 'local' | 'google' = 'local',
  permissions: StaffPermission[] = ['staff.workspace.inspect'],
) {
  const directory = vi.fn(async () => ({
    usersTruncated: false,
    workspacesTruncated: false,
    users: [],
    workspaces: [],
  }));
  const accessHistory = vi.fn(async () => ({ events: [], nextCursor: null }));
  const audit = vi.fn<StaffRuntime['service']['audit']>(async () => ({
    entries: [],
    nextCursor: null,
  }));
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
      health: async () => {
        throw new Error('Unused');
      },
      accessHistory,
      audit,
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
          permissions,
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

  return { app, staff, directory, accessHistory, audit };
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
  it('requires inspection permission and a well-formed cursor before reading access history', async () => {
    const workspace = '00000000-0000-4000-8000-000000000001';
    const grant = '00000000-0000-4000-8000-000000000002';
    const denied = fixture('local', ['staff.directory.read']);
    try {
      for (const path of ['health', 'access-history'])
        expect(
          (
            await denied.app.inject({
              url: `/v1/staff/workspaces/${workspace}/${path}?grantId=${grant}`,
              headers: { cookie: 'staff' },
            })
          ).statusCode,
        ).toBe(403);
      expect(denied.accessHistory).not.toHaveBeenCalled();
    } finally {
      await denied.app.close();
    }
    const { app, accessHistory } = fixture();
    try {
      const malformed = await app.inject({
        url: `/v1/staff/workspaces/${workspace}/access-history?grantId=${grant}&cursor=1'%20OR%201=1`,
        headers: { cookie: 'staff' },
      });
      expect(malformed.statusCode).toBe(400);
      const cursor = `2026-10-09T08:00:00.123456Z_${grant}`;
      const response = await app.inject({
        url: `/v1/staff/workspaces/${workspace}/access-history?grantId=${grant}&cursor=${cursor}`,
        headers: { cookie: 'staff' },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(accessHistory).toHaveBeenCalledOnce();
      expect(accessHistory.mock.calls[0]).toEqual([
        expect.objectContaining({ permissions: ['staff.workspace.inspect'] }),
        workspace,
        grant,
        cursor,
      ]);
    } finally {
      await app.close();
    }
  });
  it('requires the separate audit permission and rejects inverted time ranges', async () => {
    const denied = fixture('local', [
      'staff.directory.read',
      'staff.workspace.inspect',
      'staff.sessions.revoke',
    ]);
    try {
      const response = await denied.app.inject({
        url: '/v1/staff/audit',
        headers: { cookie: 'staff' },
      });
      expect(response.statusCode).toBe(403);
      expect(denied.audit).not.toHaveBeenCalled();
    } finally {
      await denied.app.close();
    }
    const { app, audit } = fixture('local', ['staff.audit.read']);
    try {
      const inverted = await app.inject({
        url: '/v1/staff/audit?from=2026-10-09T00:00:00.000Z&to=2026-10-08T00:00:00.000Z',
        headers: { cookie: 'staff' },
      });
      expect(inverted.statusCode).toBe(400);
      const response = await app.inject({
        url: '/v1/staff/audit?staff=support%40example.test&event=customer.sessions.revoked',
        headers: { cookie: 'staff' },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(audit.mock.calls[0]?.[1]).toEqual({
        staff: 'support@example.test',
        event: 'customer.sessions.revoked',
      });
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
