import type { StaffRuntime } from '@luma/staff';
import { describe, expect, it, vi } from 'vitest';

import { createStaffHttpApp } from './http-app.js';

const origin = 'https://staff.example.test';

function fixture(trustedProxy: string[] = []) {
  const authHandler = vi.fn<StaffRuntime['authHandler']>(async () =>
    Response.json({ success: true }),
  );
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected protected operation.');
  };
  const staff: StaffRuntime = {
    settings: { publicOrigin: origin, mode: 'local' },
    authHandler,
    resolveSession: unused,
    checkReadiness: async () => true,
    close: async () => {},
    service: {
      directory: unused,
      grant: unused,
      workspace: unused,
      revoke: unused,
      health: unused,
      accessHistory: unused,
      audit: unused,
    },
  };

  return { app: createStaffHttpApp(staff, trustedProxy), authHandler };
}

describe('staff ingress client address boundary', () => {
  it('keeps separate authentication limiter keys for clients forwarded by the configured proxy', async () => {
    const { app, authHandler } = fixture(['10.42.0.10']);
    try {
      for (const client of ['203.0.113.10', '203.0.113.11']) {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/sign-in/email',
          remoteAddress: '10.42.0.10',
          headers: {
            origin,
            'x-forwarded-for': client,
            'x-luma-staff-client-ip': '192.0.2.99',
            'x-real-ip': '192.0.2.99',
          },
          payload: {
            email: 'support@example.test',
            password: 'staff-password-long-enough',
          },
        });
        expect(response.statusCode).toBe(200);
      }
      const requests = authHandler.mock.calls.map(([request]) => request);
      expect(
        requests.map((request) =>
          request.headers.get('x-luma-staff-client-ip'),
        ),
      ).toEqual(['203.0.113.10', '203.0.113.11']);
      for (const request of requests) {
        expect(request.headers.get('x-forwarded-for')).toBeNull();
        expect(request.headers.get('x-real-ip')).toBeNull();
      }
    } finally {
      await app.close();
    }
  });

  it('accepts a peer inside a reviewed narrow proxy CIDR', async () => {
    const { app, authHandler } = fixture(['10.42.0.0/24']);
    try {
      await app.inject({
        method: 'POST',
        url: '/auth/sign-in/email',
        remoteAddress: '10.42.0.15',
        headers: { origin, 'x-forwarded-for': '203.0.113.10' },
        payload: {
          email: 'support@example.test',
          password: 'staff-password-long-enough',
        },
      });
      expect(
        authHandler.mock.calls[0]?.[0].headers.get('x-luma-staff-client-ip'),
      ).toBe('203.0.113.10');
    } finally {
      await app.close();
    }
  });

  it.each([{ trustedProxy: [] }, { trustedProxy: ['10.42.0.10'] }])(
    'ignores spoofed forwarding headers from an untrusted peer with config %j',
    async ({ trustedProxy }) => {
      const { app, authHandler } = fixture(trustedProxy);
      try {
        await app.inject({
          method: 'POST',
          url: '/auth/sign-in/email',
          remoteAddress: '198.51.100.50',
          headers: {
            origin,
            'x-forwarded-for': '203.0.113.10',
            forwarded: 'for=203.0.113.11',
            'x-real-ip': '203.0.113.12',
            'x-luma-staff-client-ip': '203.0.113.13',
          },
          payload: {
            email: 'support@example.test',
            password: 'staff-password-long-enough',
          },
        });
        const request = authHandler.mock.calls[0]?.[0];
        expect(request?.headers.get('x-luma-staff-client-ip')).toBe(
          '198.51.100.50',
        );
        expect(request?.headers.get('x-forwarded-for')).toBeNull();
        expect(request?.headers.get('forwarded')).toBeNull();
        expect(request?.headers.get('x-real-ip')).toBeNull();
      } finally {
        await app.close();
      }
    },
  );

  it('stops a forwarding chain at the first untrusted hop', async () => {
    const { app, authHandler } = fixture(['10.42.0.10']);
    try {
      await app.inject({
        method: 'POST',
        url: '/auth/sign-in/email',
        remoteAddress: '10.42.0.10',
        headers: { origin, 'x-forwarded-for': '203.0.113.10, 198.51.100.50' },
        payload: {
          email: 'support@example.test',
          password: 'staff-password-long-enough',
        },
      });
      expect(
        authHandler.mock.calls[0]?.[0].headers.get('x-luma-staff-client-ip'),
      ).toBe('198.51.100.50');
    } finally {
      await app.close();
    }
  });
});
