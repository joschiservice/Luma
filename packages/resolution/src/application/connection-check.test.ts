import type { TenantContext } from '@luma/identity';
import { describe, expect, it } from 'vitest';

import { connectionCheckSource } from '../domain/connection-check.js';
import { createConnectionCheckWorkflow } from './connection-check.js';
import type { SyncStreamState } from './detection-monitor.js';

const context = { tenantId: 't' } as TenantContext;
const connectionId = '00000000-0000-4000-8000-000000000001';
const signal = {
  id: '00000000-0000-4000-8000-000000000002',
  issueType: 'sync_failure',
  severity: 'medium' as const,
  subject: { kind: 'connection', id: connectionId, scope: ['orders.read'] },
  firstDetectedAt: '2026-10-06T10:00:00.000Z',
  lastDetectedAt: '2026-10-06T10:00:00.000Z',
  open: true,
};

function adapter(streams: SyncStreamState[]) {
  return createConnectionCheckWorkflow({
    version: {
      ...connectionCheckSource,
      format: 'workflow/2',
      digest: 'c'.repeat(64),
    },
    sources: { streams: async () => streams },
    now: () => new Date('2026-10-06T10:01:00.000Z'),
  });
}

const stream = (overrides: Partial<SyncStreamState>): SyncStreamState => ({
  id: '00000000-0000-4000-8000-000000000003',
  connectionId,
  provider: 'shopify',
  capability: 'orders.read',
  active: true,
  attempts: 6,
  errorCode: 'unavailable',
  errorAt: '2026-10-06T09:59:00.000Z',
  failingSince: '2026-10-06T09:40:00.000Z',
  lastCompleteAt: '2026-10-06T09:30:00.000Z',
  ...overrides,
});

const read = (streams: SyncStreamState[]) =>
  adapter(streams).read(
    context,
    {
      signal,
      run: {} as never,
      activation: {} as never,
      stop: null,
      evidence: async () => [],
    },
    { id: 'failure', kind: 'read', source: 'sync.stream', fields: {} },
  );

describe('connection check', () => {
  it('waits on a provider outage instead of handing it over', async () => {
    expect((await read([stream({})])).values).toEqual({
      ready: true,
      accessLost: false,
      failing: true,
      errorCode: 'unavailable',
    });
  });

  it('hands lost access to a person straight away', async () => {
    expect(
      (await read([stream({ errorCode: 'authentication' })])).values,
    ).toMatchObject({ accessLost: true });
    expect(
      (await read([stream({ active: false, attempts: 0, failingSince: null })]))
        .values,
    ).toMatchObject({ accessLost: true, failing: false });
  });

  it('reports recovered reads and missing streams', async () => {
    expect(
      (await read([stream({ attempts: 0, failingSince: null })])).values,
    ).toMatchObject({ ready: true, failing: false, accessLost: false });
    const missing = await read([]);
    expect(missing.values.ready).toBe(false);
    expect(missing.evidenceRefs).toEqual([signal.id]);
  });

  it('acts only on sync failures', async () => {
    const check = adapter([]);
    expect(await check.subject(context, signal, [])).toEqual({
      kind: 'connection',
      id: connectionId,
    });
    expect(
      await check.subject(
        context,
        { ...signal, issueType: 'stuck_fulfillment' },
        [],
      ),
    ).toBeNull();
  });
});
