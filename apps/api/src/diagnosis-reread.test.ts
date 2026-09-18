import { describe, expect, it, vi } from 'vitest';
import { makeTenantContext } from './modules/identity/composition.js';
import { createDiagnosisRereader } from './modules/workflows/index.js';
import type { DiagnosisInput } from './modules/exceptions/index.js';
import { defaultConfiguration } from './modules/exceptions/index.js';
import type {
  CapabilityReader,
  CapabilityRequest,
  ReadCapability,
} from './modules/connectors/index.js';
const context = makeTenantContext(
  { userId: 'operator', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Fixture',
    slug: 'fixture',
    dataRegion: 'EU',
    status: 'active',
  },
  { id: 'member', organizationId: 'tenant', userId: 'operator', role: 'owner' },
  'request',
);
const now = new Date('2026-09-17T12:00:00Z');
const snapshot: DiagnosisInput = {
  exceptionId: 'incident',
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
      evidenceRefs: ['event'],
      connectionId: 'connection',
      capability: 'inventory.read',
      active: true,
      status: 'success',
      scanComplete: false,
      errorCode: null,
      firstFailureAt: now.toISOString(),
      retryExhausted: false,
    },
  },
  configuration: defaultConfiguration,
  evidence: [
    {
      key: 'event',
      tenantId: 'tenant',
      connectionId: 'connection',
      source: null,
      observedAt: now.toISOString(),
      sourceUpdatedAt: null,
      schemaVersion: 1,
      adapterVersion: 'fixture',
      facts: {},
    },
  ],
};
const request: CapabilityRequest<ReadCapability> = {
  connectionId: 'connection',
  capability: 'inventory.read',
  version: '0',
  input: { limit: 1 },
};
function setup(requests = [request], notBefore: string | null = null) {
  const read = vi.fn(async () => ({
    ok: true as const,
    value: { items: [], nextCursor: 'next', completeness: 'partial' as const },
  }));
  const publish = vi.fn(async () => {});
  const reader = createDiagnosisRereader(
    { discover: async () => [], read: read as CapabilityReader['read'] },
    { plan: async () => ({ requests, notBefore }), publish },
    () => now,
  );
  return { reader, read, publish };
}
describe('bounded diagnosis rereads', () => {
  it('uses the scoped read port and preserves partial-page provenance', async () => {
    const { reader, read, publish } = setup();
    expect(
      await reader.read(context, snapshot, new AbortController().signal),
    ).toEqual({ status: 'completed', retryAfter: null });
    expect(read).toHaveBeenCalledWith(context, request);
    expect(publish).toHaveBeenCalledWith(context, snapshot, [
      { items: [], nextCursor: 'next', completeness: 'partial' },
    ]);
  });
  it('honors retained provider backoff without making a request', async () => {
    const retryAfter = '2026-09-17T12:01:00Z';
    const { reader, read } = setup([request], retryAfter);
    expect(
      await reader.read(context, snapshot, new AbortController().signal),
    ).toEqual({ status: 'rate_limited', retryAfter });
    expect(read).not.toHaveBeenCalled();
  });
  it('limits each investigation to two reads', async () => {
    const { reader, read } = setup([request, request, request]);
    expect(
      await reader.read(context, snapshot, new AbortController().signal),
    ).toMatchObject({ status: 'unavailable' });
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects writes and connections outside the incident scope', async () => {
    for (const change of [
      { connectionId: 'other' },
      { capability: 'inventory.write' as ReadCapability },
    ]) {
      const { reader, read } = setup([{ ...request, ...change }]);
      await expect(
        reader.read(context, snapshot, new AbortController().signal),
      ).rejects.toThrow('scope');
      expect(read).not.toHaveBeenCalled();
    }
  });
  it('does not publish results after the investigation is cancelled', async () => {
    const controller = new AbortController();
    const { reader, read, publish } = setup();
    read.mockImplementation(async () => {
      controller.abort();
      return {
        ok: true,
        value: { items: [], nextCursor: 'next', completeness: 'partial' },
      };
    });
    await expect(
      reader.read(context, snapshot, controller.signal),
    ).rejects.toThrow('cancelled');
    expect(publish).not.toHaveBeenCalled();
  });
  it('retains provider retry-after without looping', async () => {
    const read = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'rate_limited' as const,
        retry: 'after_delay' as const,
        effect: 'none' as const,
        retryAfterMs: 60_000,
      },
    }));
    const publish = vi.fn();
    const reader = createDiagnosisRereader(
      { discover: async () => [], read: read as CapabilityReader['read'] },
      {
        plan: async () => ({ requests: [request, request], notBefore: null }),
        publish,
      },
      () => now,
    );
    expect(
      await reader.read(context, snapshot, new AbortController().signal),
    ).toEqual({
      status: 'rate_limited',
      retryAfter: '2026-09-17T12:01:00.000Z',
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });
});
