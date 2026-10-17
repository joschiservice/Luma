import { describe, expect, it } from 'vitest';

import { readAuthProtectionConfig } from './auth-protection.js';

describe('sign-in protection configuration', () => {
  it('limits requests by default and shares counters through Valkey when configured', () => {
    expect(readAuthProtectionConfig({})).toEqual({
      rateLimit: { enabled: true },
    });
    expect(
      readAuthProtectionConfig({
        AUTH_RATE_LIMIT_URL: 'rediss://luma:secret@valkey.example:6379',
        AUTH_CLIENT_IP_HEADER: 'X-Real-IP',
      }),
    ).toEqual({
      rateLimit: {
        enabled: true,
        store: {
          url: 'rediss://luma:secret@valkey.example:6379',
          cluster: false,
        },
      },
      clientIpHeader: 'x-real-ip',
    });
  });

  it('turns limits off only outside production', () => {
    expect(readAuthProtectionConfig({ AUTH_RATE_LIMIT: 'off' })).toEqual({
      rateLimit: { enabled: false },
    });
    expect(() =>
      readAuthProtectionConfig({
        AUTH_RATE_LIMIT: 'off',
        NODE_ENV: 'production',
      }),
    ).toThrow('AUTH_RATE_LIMIT cannot be off in production');
    expect(() => readAuthProtectionConfig({ AUTH_RATE_LIMIT: 'no' })).toThrow(
      'AUTH_RATE_LIMIT must be on or off',
    );
  });

  it.each(['x real ip', 'x-luma-client-ip', 'x_forwarded'])(
    'rejects the client address header %s',
    (header) => {
      expect(() =>
        readAuthProtectionConfig({ AUTH_CLIENT_IP_HEADER: header }),
      ).toThrow('AUTH_CLIENT_IP_HEADER');
    },
  );

  it('rejects a store URL with a database', () => {
    expect(() =>
      readAuthProtectionConfig({
        AUTH_RATE_LIMIT_URL: 'redis://valkey.example:6379/2',
      }),
    ).toThrow('AUTH_RATE_LIMIT_URL must be a redis://');
  });
});
