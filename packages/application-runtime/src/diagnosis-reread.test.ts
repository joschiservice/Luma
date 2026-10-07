import type {
  CapabilityReader,
  CapabilityRequest,
  ReadCapability,
} from '@luma/connections';
import type { DiagnosisInput } from '@luma/exceptions';
import { defaultConfiguration } from '@luma/exceptions';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createDiagnosisRereader } from '@luma/resolution';
import { describe, expect, it, vi } from 'vitest';

const context = makeTenantContext(
  { userId: 'operator', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Fixture',
    slug: 'fixture',
    dataRegion: 'EU',
    status: 'active',
  },
  builtInMembership(
    { id: 'member', organizationId: 'tenant', userId: 'operator' },
    'owner',
  ),
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
    expect(publish).toHaveBeenCalledWith(
      context,
      snapshot,
      [{ items: [], nextCursor: 'next', completeness: 'partial' }],
      expect.any(AbortSignal),
    );
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
  it('rejects unrelated capabilities and resource subsets of a sync scan before any read', async () => {
    for (const outside of [
      { ...request, capability: 'orders.read' as const },
      {
        ...request,
        input: { limit: 1, sku: { externalId: 'unrelated', scopeKey: '' } },
      },
    ]) {
      const { reader, read, publish } = setup([request, outside]);
      await expect(
        reader.read(context, snapshot, new AbortController().signal),
      ).rejects.toThrow('scope');
      expect(read).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    }
  });

  it('binds inventory reads to both mapped SKU and stock pool, including source namespaces', async () => {
    const sku = { externalId: 'sku-1', scopeKey: 'catalog' };
    const location = { externalId: 'pool-1', scopeKey: 'stock' };
    const value: DiagnosisInput = {
      ...snapshot,
      subject: {
        kind: 'sku',
        id: 'canonical-sku',
        scope: ['canonical-pool', 'connection', 'second'],
      },
      input: {
        exceptionClass: 'inventory_mismatch',
        facts: {
          tenantId: 'tenant',
          evidenceTenantId: 'tenant',
          subjectId: 'canonical-sku',
          evidenceRefs: ['event', 'mapping'],
          connectionIds: ['connection', 'second'],
          canonicalLocationId: 'canonical-pool',
          leftAvailable: '4',
          rightAvailable: '12',
          leftUnit: 'each',
          rightUnit: 'each',
          leftObservedAt: now.toISOString(),
          rightObservedAt: now.toISOString(),
          leftBasis: 'provider_reported',
          rightBasis: 'provider_reported',
          mappedSku: true,
          equivalentPool: true,
          complete: true,
          projectionCurrent: true,
          authority: 'left',
          sellingSource: 'right',
          tolerance: '0',
        },
      },
      evidence: [
        ...snapshot.evidence,
        {
          ...snapshot.evidence[0]!,
          key: 'mapping',
          connectionId: null,
          adapterVersion: 'canonical-mapping-v1',
          facts: {
            tenantId: 'tenant',
            skuId: 'canonical-sku',
            locationId: 'canonical-pool',
            left: {
              source: { tenantId: 'tenant', connectionId: 'connection' },
              sku,
              location,
            },
            right: {
              source: { tenantId: 'tenant', connectionId: 'second' },
              sku: { ...sku, externalId: 'other-sku' },
              location,
            },
          },
        },
      ],
    };
    const scoped = { ...request, input: { limit: 1, sku, location } };
    const valid = setup([
      scoped,
      {
        ...scoped,
        connectionId: 'second',
        input: { limit: 1, sku: { ...sku, externalId: 'other-sku' }, location },
      },
    ]);
    expect(
      await valid.reader.read(context, value, new AbortController().signal),
    ).toMatchObject({ status: 'completed' });
    expect(valid.read).toHaveBeenCalledTimes(2);
    for (const input of [
      { limit: 1 },
      { limit: 1, sku },
      { limit: 1, sku: { ...sku, scopeKey: 'another-catalog' }, location },
      {
        limit: 1,
        sku,
        location: { ...location, externalId: 'unrelated-pool' },
      },
    ]) {
      const denied = setup([{ ...request, input }]);
      await expect(
        denied.reader.read(context, value, new AbortController().signal),
      ).rejects.toThrow('scope');
      expect(denied.read).not.toHaveBeenCalled();
    }
    for (const changes of [
      { evidence: snapshot.evidence },
      { subject: { ...value.subject, id: 'different-canonical-sku' } },
      { evidence: [...value.evidence, value.evidence[1]!] },
    ]) {
      const denied = setup([scoped]);
      await expect(
        denied.reader.read(
          context,
          { ...value, ...changes },
          new AbortController().signal,
        ),
      ).rejects.toThrow('scope');
      expect(denied.read).not.toHaveBeenCalled();
    }
  });
  it('restricts fulfillment rereads to the mapped order and rejects workflow connector reads', async () => {
    const order = { externalId: 'order-1', scopeKey: 'shop' };
    const value: DiagnosisInput = {
      ...snapshot,
      subject: { kind: 'fulfillment', id: 'operation', scope: ['connection'] },
      input: {
        exceptionClass: 'stuck_fulfillment',
        facts: {
          tenantId: 'tenant',
          evidenceTenantId: 'tenant',
          subjectId: 'operation',
          evidenceRefs: ['event', 'mapping'],
          connectionId: 'connection',
          status: 'failed',
          observedAt: now.toISOString(),
          lastProgressAt: null,
          quantity: '1',
          unit: 'each',
          mapped: true,
          complete: true,
          eligibility: 'eligible',
          progressBasis: 'source_updated',
          otherOperationShippedQuantity: '0',
        },
      },
      evidence: [
        ...snapshot.evidence,
        {
          ...snapshot.evidence[0]!,
          key: 'mapping',
          connectionId: null,
          adapterVersion: 'canonical-mapping-v1',
          facts: {
            tenantId: 'tenant',
            fulfillmentId: 'operation',
            source: { tenantId: 'tenant', connectionId: 'connection' },
            order,
          },
        },
      ],
    };
    const scoped: CapabilityRequest<ReadCapability> = {
      ...request,
      capability: 'fulfillment.read',
      input: { limit: 1, order },
    };
    expect(
      await setup([scoped]).reader.read(
        context,
        value,
        new AbortController().signal,
      ),
    ).toMatchObject({ status: 'completed' });
    for (const outside of [
      request,
      { ...scoped, input: { limit: 1 } },
      {
        ...scoped,
        input: { limit: 1, order: { ...order, scopeKey: 'other-shop' } },
      },
    ]) {
      const denied = setup([outside]);
      await expect(
        denied.reader.read(context, value, new AbortController().signal),
      ).rejects.toThrow('scope');
      expect(denied.read).not.toHaveBeenCalled();
    }
    const workflow: DiagnosisInput = {
      ...snapshot,
      input: {
        exceptionClass: 'workflow_failure',
        facts: {
          tenantId: 'tenant',
          evidenceTenantId: 'tenant',
          subjectId: 'run',
          evidenceRefs: ['event'],
          runId: 'run',
          stepKey: 'step',
          attempt: 1,
          status: 'failed',
          durable: true,
          retryExhausted: true,
          effect: 'unknown',
          executionId: 'execution',
          errorCode: 'timeout',
        },
      },
    };
    const denied = setup();
    await expect(
      denied.reader.read(context, workflow, new AbortController().signal),
    ).rejects.toThrow('scope');
    expect(denied.read).not.toHaveBeenCalled();
  });
  it('cancels publication already in progress before it commits', async () => {
    const controller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commit = vi.fn();
    const reader = createDiagnosisRereader(
      {
        discover: async () => [],
        read: async () => ({
          ok: true,
          value: { items: [], nextCursor: null, completeness: 'complete' },
        }),
      },
      {
        plan: async () => ({ requests: [request], notBefore: null }),
        publish: async (_context, _snapshot, _pages, signal) => {
          expect(signal).toBe(controller.signal);
          started();
          await gate;
          signal.throwIfAborted();
          commit();
        },
      },
      () => now,
    );
    const pending = reader.read(context, snapshot, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await entered;
    controller.abort();
    release();
    await rejected;
    expect(commit).not.toHaveBeenCalled();
  });
});
