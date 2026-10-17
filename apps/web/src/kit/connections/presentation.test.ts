import type { InstalledConnection } from '@luma/api-contract';
import { expect, it } from 'vitest';

import {
  connectionAccess,
  connectionState,
  connectionTarget,
} from './presentation';

const connection = {
  status: 'active',
  permissions: ['orders.read', 'returns.create', 'customers.read'],
  granted: ['orders.read', 'returns.create'],
} satisfies Pick<InstalledConnection, 'status' | 'permissions' | 'granted'>;

it('classifies every non-read capability as a change', () => {
  expect(connectionAccess(connection)).toEqual({
    reads: ['orders.read'],
    changes: ['returns.create'],
    unavailable: ['customers.read'],
    level: 'read_write',
  });
});

it.each(['pending', 'degraded', 'revoked', 'disconnected'] as const)(
  'permits nothing while %s',
  (status) => {
    expect(connectionAccess({ ...connection, status })).toMatchObject({
      reads: [],
      changes: [],
      level: 'none',
    });
  },
);

it('permits nothing when the app is unavailable', () => {
  expect(connectionAccess(connection, false).level).toBe('none');
});

it('prefers shared health but never reports a pending connection as importing', () => {
  const coverage = {
    health: 'importing',
    lastObservedAt: null,
    freshness: 'unobserved',
  } as const;
  expect(connectionState({ status: 'active', coverage })).toEqual({
    state: 'waiting',
    label: 'Importing',
    attention: false,
  });
  expect(connectionState({ status: 'pending', coverage })).toEqual({
    state: 'waiting',
    label: 'Awaiting validation',
    attention: true,
  });
  expect(
    connectionState({
      status: 'active',
      coverage: { ...coverage, health: 'delayed' },
    }).attention,
  ).toBe(true);
  expect(connectionState({ status: 'disconnected' }).attention).toBe(false);
});

it('names the recognizable account and labels every target field', () => {
  const target = connectionTarget({
    kind: 'jtl-onprem',
    appId: 'Luma',
    baseUrl: 'https://erp.example.test/api/',
    appVersion: '1',
  });
  expect(target.primary).toBe('https://erp.example.test/api/');
  expect(target.fields.map((field) => field.label)).toEqual([
    'App ID',
    'API URL',
    'App version',
  ]);
  expect(connectionTarget({ kind: 'custom', region: 'eu' })).toEqual({
    primary: 'eu',
    fields: [{ key: 'region', label: 'region', value: 'eu' }],
  });
});
