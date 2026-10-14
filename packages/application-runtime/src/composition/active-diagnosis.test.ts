import type { CapabilityReader } from '@luma/connections';
import type { DiagnosisInput } from '@luma/exceptions';
import { defaultConfiguration } from '@luma/exceptions';
import {
  builtInMembership,
  IdentityError,
  makeTenantContext,
} from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { expect, it, vi } from 'vitest';

import { createActiveDiagnosisRereader } from './active-diagnosis.js';

const context = makeTenantContext(
  { userId: 'operator', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Tenant',
    slug: 'tenant',
    dataRegion: 'AU',
    status: 'active',
  },
  builtInMembership(
    { id: 'member', organizationId: 'tenant', userId: 'operator' },
    'admin',
  ),
  'request',
);
const now = new Date('2026-10-13T00:00:00.000Z');
const snapshot: DiagnosisInput = {
  exceptionId: 'case',
  revision: 1,
  firstDetectedAt: now.toISOString(),
  reviewRequired: false,
  subject: { kind: 'connection', id: 'connection', scope: ['inventory.read'] },
  input: {
    exceptionClass: 'sync_failure',
    facts: {
      tenantId: 'tenant',
      evidenceTenantId: 'tenant',
      subjectId: 'connection',
      evidenceRefs: ['read'],
      connectionId: 'connection',
      capability: 'inventory.read',
      active: true,
      status: 'failed',
      scanComplete: false,
      errorCode: 'transient',
      firstFailureAt: now.toISOString(),
      retryExhausted: true,
    },
  },
  configuration: defaultConfiguration,
  evidence: [],
};

function setup(enabled: boolean) {
  const database: TenantDatabase = {
    transaction: async (_tenant, operation) =>
      operation({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const transaction = vi.spyOn(database, 'transaction');
  const read = vi.fn<CapabilityReader['read']>(async () => {
    throw new Error('Unexpected provider read');
  });
  const discover = vi.fn<CapabilityReader['discover']>().mockResolvedValue([]);
  const refreshContext = vi.fn(async () => context);
  const adapter = createActiveDiagnosisRereader({
    database,
    reader: { read, discover },
    identity: { refreshContext },
    enabled: async () => enabled,
    now: () => now,
  });
  if (!adapter) throw new Error('Missing adapter');

  return { adapter, transaction, read, discover, refreshContext };
}

it('is default-off and never opens a database lease or reads a provider without the release', async () => {
  const env = setup(false);
  expect(
    await env.adapter.read(context, snapshot, new AbortController().signal),
  ).toEqual({ status: 'unavailable', retryAfter: null });
  expect(env.transaction).not.toHaveBeenCalled();
  expect(env.read).not.toHaveBeenCalled();
});

it('evaluates a revision with retained investigation evidence without an infinite reread chain', async () => {
  const env = setup(true);
  const retained = structuredClone(snapshot);
  retained.evidence.push({
    key: 'investigation',
    tenantId: 'tenant',
    connectionId: null,
    source: null,
    observedAt: now.toISOString(),
    sourceUpdatedAt: null,
    adapterVersion: 'diagnosis-investigation-v1',
    schemaVersion: 1,
    facts: { incidentId: 'case' },
  });
  expect(
    await env.adapter.read(context, retained, new AbortController().signal),
  ).toEqual({ status: 'completed', retryAfter: null });
  expect(env.transaction).not.toHaveBeenCalled();
  expect(env.read).not.toHaveBeenCalled();
});

it('honors an occupied durable incident lease and fails before access-loss or cancelled work can read', async () => {
  const env = setup(true);
  expect(
    await env.adapter.read(context, snapshot, new AbortController().signal),
  ).toEqual({ status: 'rate_limited', retryAfter: '2026-10-13T00:00:05.000Z' });
  expect(env.read).not.toHaveBeenCalled();
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    env.adapter.read(context, snapshot, aborted.signal),
  ).rejects.toThrow();
  env.refreshContext.mockRejectedValue(
    new IdentityError(403, 'FORBIDDEN', 'Access changed'),
  );
  await expect(
    env.adapter.read(context, snapshot, new AbortController().signal),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(env.read).not.toHaveBeenCalled();
});
