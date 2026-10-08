import { describe, expect, it } from 'vitest';

import { readStaffSettings, validateStaffProvisioning } from './settings.js';

const env = {
  STAFF_DATABASE_URL: 'postgresql://staff:password@127.0.0.1:5432/test',
  STAFF_AUTH_SECRET: 'a-secret-at-least-thirty-two-characters',
  STAFF_PUBLIC_ORIGIN: 'http://localhost:3000',
  STAFF_AUTH_MODE: 'local',
  STAFF_API_PORT: '3002',
  STAFF_API_HOST: '127.0.0.1',
};
describe('staff configuration safety', () => {
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
