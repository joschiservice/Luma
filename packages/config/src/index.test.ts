import { describe, expect, it } from 'vitest';

import { readApiConfig, readIdentityConfig } from './index.js';

describe('readApiConfig', () => {
  it('provides local defaults without requiring secrets', () => {
    expect(readApiConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3001,
      logLevel: 'info',
    });
  });
  it('accepts explicit runtime configuration', () => {
    expect(
      readApiConfig({ HOST: '0.0.0.0', PORT: '8080', LOG_LEVEL: 'warn' }),
    ).toEqual({ host: '0.0.0.0', port: 8080, logLevel: 'warn' });
  });
  it('accepts port zero for an operating-system assigned listener', () => {
    expect(readApiConfig({ PORT: '0' }).port).toBe(0);
  });
  it.each(['', '-1', '65536', '3001x', '1.5', '1e3', ' 3001'])(
    'rejects invalid port %j',
    (PORT) => {
      expect(() => readApiConfig({ PORT })).toThrow('PORT');
    },
  );
  it('rejects invalid host and logging settings', () => {
    expect(() => readApiConfig({ HOST: ' ' })).toThrow('HOST');
    expect(() => readApiConfig({ LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
  });
});

const authEnvironment = {
  IDENTITY_DATABASE_URL: 'postgresql://runtime:local@localhost/luma',
  BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
  BETTER_AUTH_URL: 'http://localhost:3001',
  AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
};

it('accepts distinct cookie namespaces and rejects invalid cookie names', () => {
  expect(
    readIdentityConfig({
      LUMA_REGION: 'EU',
      LUMA_ENABLED_REGIONS: 'EU',
      ...authEnvironment,
      BETTER_AUTH_COOKIE_PREFIX: 'luma-worktree_1',
    }).cookiePrefix,
  ).toBe('luma-worktree_1');
  expect(readIdentityConfig(authEnvironment).cookiePrefix).toBeUndefined();
  for (const value of ['', 'has spaces', 'cookie;path=/', 'x'.repeat(65)]) {
    expect(() =>
      readIdentityConfig({
        LUMA_REGION: 'EU',
        LUMA_ENABLED_REGIONS: 'EU',
        ...authEnvironment,
        BETTER_AUTH_COOKIE_PREFIX: value,
      }),
    ).toThrow('BETTER_AUTH_COOKIE_PREFIX');
  }
});

it('requires explicit identity credentials and exact trusted origins', () => {
  expect(readIdentityConfig(authEnvironment).trustedOrigins).toEqual([
    'http://localhost:3001',
    'http://localhost:3000',
  ]);
  for (const key of [
    'IDENTITY_DATABASE_URL',
    'BETTER_AUTH_SECRET',
    'BETTER_AUTH_URL',
  ]) {
    expect(() =>
      readIdentityConfig({
        LUMA_REGION: 'EU',
        LUMA_ENABLED_REGIONS: 'EU',
        ...authEnvironment,
        [key]: undefined,
      }),
    ).toThrow();
  }
  for (const AUTH_TRUSTED_ORIGINS of [
    '*',
    'https://*.example.com',
    'https://example.com/path',
    'https://user:pass@example.com',
  ]) {
    expect(() =>
      readIdentityConfig({
        LUMA_REGION: 'EU',
        LUMA_ENABLED_REGIONS: 'EU',
        ...authEnvironment,
        AUTH_TRUSTED_ORIGINS,
      }),
    ).toThrow();
  }
  expect(() =>
    readIdentityConfig({ ...authEnvironment, NODE_ENV: 'production' }),
  ).toThrow('HTTPS');
  expect(() =>
    readIdentityConfig({
      LUMA_REGION: 'EU',
      LUMA_ENABLED_REGIONS: 'EU',
      ...authEnvironment,
      BETTER_AUTH_SECRET: 'short',
    }),
  ).toThrow('32');
});

it('reads the optional Resend webhook secret only with the mail settings', () => {
  const mail = {
    LUMA_REGIONAL_SERVICE_ENDPOINTS:
      '{"EU":{"mail":["https://api.resend.com"]}}',
    LUMA_REGION: 'EU',
    LUMA_ENABLED_REGIONS: 'EU',
    ...authEnvironment,
    MAIL_RESEND_API_KEY: 're_test',
    MAIL_FROM: 'Luma <notifications@example.test>',
    MAIL_PUBLIC_ORIGIN: 'http://localhost:3000',
  };
  expect(readIdentityConfig(mail).mail).not.toHaveProperty('webhookSecret');
  expect(
    readIdentityConfig({
      ...mail,
      MAIL_RESEND_WEBHOOK_SECRET: 'whsec_c2VjcmV0LXNpZ25pbmcta2V5',
    }).mail?.webhookSecret,
  ).toBe('whsec_c2VjcmV0LXNpZ25pbmcta2V5');
  expect(() =>
    readIdentityConfig({ ...mail, MAIL_RESEND_WEBHOOK_SECRET: 'not-a-secret' }),
  ).toThrow('MAIL_RESEND_WEBHOOK_SECRET');
  expect(() =>
    readIdentityConfig({
      LUMA_REGION: 'EU',
      LUMA_ENABLED_REGIONS: 'EU',
      ...authEnvironment,
      MAIL_RESEND_WEBHOOK_SECRET: 'whsec_c2VjcmV0LXNpZ25pbmcta2V5',
    }),
  ).toThrow('MAIL_RESEND_WEBHOOK_SECRET needs');
});
