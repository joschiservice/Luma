import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readStaffSettings,
  validateLocalStaffDatabaseUrl,
  validateStaffProvisioning,
} from './settings.js';

const env = {
  STAFF_DATABASE_URL: 'postgresql://staff:password@127.0.0.1:5432/test',
  STAFF_AUTH_SECRET: 'a-secret-at-least-thirty-two-characters',
  STAFF_PUBLIC_ORIGIN: 'http://localhost:3000',
  STAFF_AUTH_MODE: 'local',
  STAFF_API_PORT: '3002',
  STAFF_API_HOST: '127.0.0.1',
};
describe('staff configuration safety', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('does not trust forwarded addresses without an explicit proxy list', () => {
    expect(readStaffSettings(env).trustedProxy).toEqual([]);
  });
  it('accepts exact IPv4/IPv6 proxies and narrowly bounded CIDR ranges', () => {
    expect(
      readStaffSettings({
        ...env,
        STAFF_TRUSTED_PROXY: '127.0.0.1, ::1, 10.42.0.0/24, fd00::100/120',
      }).trustedProxy,
    ).toEqual(['127.0.0.1', '::1', '10.42.0.0/24', 'fd00::100/120']);
  });
  it.each([
    'true',
    'false',
    '1',
    '*',
    'loopback',
    'uniquelocal',
    'proxy.example.com',
    '0.0.0.0/0',
    '::/0',
    '10.0.0.0/8',
    '10.42.0.0/23',
    'fd00::/119',
    '127.0.0.1/33',
    '::1/129',
    '127.0.0.1,',
    '127.0.0.1/24/24',
  ])('rejects unsafe proxy trust %s', (value) => {
    expect(() =>
      readStaffSettings({ ...env, STAFF_TRUSTED_PROXY: value }),
    ).toThrow();
  });
  it('requires a reviewed trusted proxy for deployed Google login', () => {
    const google = {
      ...env,
      NODE_ENV: 'production',
      STAFF_AUTH_MODE: 'google',
      STAFF_PUBLIC_ORIGIN: 'https://staff.example.com',
      STAFF_REGIONAL_API_ORIGINS: '{"AU":"https://au.staff-api.example.com"}',
      STAFF_GOOGLE_CLIENT_ID: 'google-client',
      STAFF_GOOGLE_CLIENT_SECRET: 'google-secret',
      STAFF_GOOGLE_HOSTED_DOMAIN: 'example.com',
    };
    expect(() => readStaffSettings(google)).toThrow(
      'explicit trusted ingress proxy',
    );
    expect(
      readStaffSettings({ ...google, STAFF_TRUSTED_PROXY: '127.0.0.1' })
        .trustedProxy,
    ).toEqual(['127.0.0.1']);
    expect(() =>
      readStaffSettings({
        ...google,
        STAFF_TRUSTED_PROXY: '127.0.0.1',
        STAFF_REGIONAL_API_ORIGINS: '{}',
      }),
    ).toThrow('regional API origin');
  });
  it('allows a bounded loopback development login', () => {
    expect(readStaffSettings(env).mode).toBe('local');
  });
  it.each([
    { NODE_ENV: 'production' },
    { STAFF_API_HOST: '0.0.0.0' },
    { STAFF_PUBLIC_ORIGIN: 'http://staff.example.com' },
    { STAFF_DATABASE_URL: 'postgresql://staff:password@db.example.com/test' },
  ])('rejects unsafe local mode %j', (override) => {
    expect(() => readStaffSettings({ ...env, ...override })).toThrow();
  });
  it.each([
    { STAFF_DATABASE_URL: 'https://localhost/test' },
    { STAFF_PUBLIC_ORIGIN: 'ftp://localhost:3000' },
    { STAFF_DATABASE_URL: 'invalid-url' },
  ])('rejects unsupported URL protocols %j', (override) => {
    expect(() => readStaffSettings({ ...env, ...override })).toThrow();
  });
  it.each([
    'postgresql://staff:password@localhost/test?host=db.example.com',
    'postgresql://staff:password@127.0.0.1/test?host=%64b.example.com',
    'postgresql://staff:password@localhost/test?host=/tmp/postgres',
  ])(
    'rejects effective PostgreSQL host overrides for runtime and seed %s',
    (databaseUrl) => {
      expect(() =>
        readStaffSettings({ ...env, STAFF_DATABASE_URL: databaseUrl }),
      ).toThrow();
      expect(() => validateLocalStaffDatabaseUrl(databaseUrl)).toThrow();
    },
  );
  it('uses the driver-normalized URL host even when PGHOST is remote', () => {
    vi.stubEnv('PGHOST', 'db.example.com');
    const databaseUrl = 'postgresql://staff:password@localhost/test?host=';
    expect(
      readStaffSettings({ ...env, STAFF_DATABASE_URL: databaseUrl }).mode,
    ).toBe('local');
    expect(validateLocalStaffDatabaseUrl(databaseUrl)).toBe(databaseUrl);
  });
  it('accepts the effective IPv6 loopback driver host', () => {
    expect(
      readStaffSettings({
        ...env,
        STAFF_DATABASE_URL: 'postgresql://staff:password@[::1]/test',
      }).mode,
    ).toBe('local');
  });
  it('validates explicit provisioning fields before connecting', () => {
    expect(() =>
      validateStaffProvisioning({
        email: 'staff@example.test',
        subject: 'subject',
        active: 'yes',
        permissions: ['staff.directory.read'],
        operator: 'admin',
        reason: 'Approved staff support enrollment',
      }),
    ).toThrow();
    expect(() =>
      validateStaffProvisioning({
        email: 'staff@example.test',
        subject: 'subject',
        active: true,
        permissions: ['members.manage'],
        operator: 'admin',
        reason: 'Approved staff support enrollment',
      }),
    ).toThrow();
  });
  it('fails closed when Google identity configuration is incomplete', () => {
    expect(() =>
      readStaffSettings({
        ...env,
        STAFF_AUTH_MODE: 'google',
        STAFF_PUBLIC_ORIGIN: 'https://staff.example.com',
        NODE_ENV: 'production',
      }),
    ).toThrow();
  });
});
