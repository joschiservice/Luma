import type {
  CapabilityReader,
  CapabilityRequest,
  CapabilityResult,
  InventorySnapshot,
  Observation,
} from '@luma/connections';
import type { DetectionService, Incident } from '@luma/exceptions';
import { defaultConfiguration, evaluateException } from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import type { InventoryMapping } from './detection.js';
import { createInventoryMonitor } from './inventory-monitor.js';

vi.mock('@luma/identity', () => ({
  requireTenant: (context: TenantContext, tenantId: string) => {
    if (context.tenantId !== tenantId) throw new Error('Tenant mismatch');
  },
}));

const randomUUID = () => crypto.randomUUID();
const tenantId = randomUUID();
const context = {
  tenantId,
  actor: { id: 'owner', role: 'owner' },
} as TenantContext;
const now = new Date('2026-09-24T01:00:00Z');

function fixture() {
  const side = (provider: string) => ({
    source: {
      tenantId,
      connectionId: randomUUID(),
      provider,
      resource: 'sku' as const,
      externalId: 'item',
      scopeKey: 'pool',
    },
    sku: { externalId: 'item', scopeKey: '' },
    location: { externalId: 'pool', scopeKey: '' },
  });
  const mapping: InventoryMapping = {
    tenantId,
    version: 'v1',
    publishedAt: now.toISOString(),
    skuId: randomUUID(),
    locationId: randomUUID(),
    left: side('jtl'),
    right: side('shopify'),
    authority: 'left',
    sellingSource: 'right',
  };
  const sample = (
    side: InventoryMapping['left'],
  ): Observation<InventorySnapshot> => ({
    id: randomUUID(),
    source: side.source,
    kind: 'snapshot',
    observedAt: now.toISOString(),
    sourceUpdatedAt: null,
    sourceRevision: null,
    adapterVersion: `${side.source.provider}/0`,
    schemaVersion: 1,
    data: {
      sku: { ...side.sku },
      location: { ...side.location },
      unit: 'each',
      onHand: '100',
      reserved: '4',
      available: '96',
      availabilityBasis: 'provider_reported',
    },
  });
  const read = vi.fn<
    (
      context: TenantContext,
      request: CapabilityRequest<'inventory.read'>,
    ) => Promise<CapabilityResult<'inventory.read'>>
  >(async (_actor, request) => ({
    ok: true,
    value: {
      items: [
        sample(
          request.connectionId === mapping.left.source.connectionId
            ? mapping.left
            : mapping.right,
        ),
      ],
      nextCursor: null,
      completeness: 'complete',
    },
  }));
  const project = vi.fn(async () => true);
  const monitor = createInventoryMonitor({
    mapping,
    configuration: defaultConfiguration,
    capabilities: { read: read as CapabilityReader['read'] },
    project,
    hash: (value) => value,
    now: () => now,
  });
  const incident: Incident = {
    id: randomUUID(),
    tenantId,
    fingerprint: '0'.repeat(64),
    exceptionClass: 'inventory_mismatch',
    subject: {
      ruleIdentity: 'available-stock',
      subjectKind: 'sku',
      subjectId: mapping.skuId,
      scope: [
        mapping.locationId,
        ...[
          mapping.left.source.connectionId,
          mapping.right.source.connectionId,
        ].sort(),
      ],
    },
    severity: 'high',
    state: 'detected',
    firstDetectedAt: now.toISOString(),
    lastDetectedAt: now.toISOString(),
    occurrenceCount: 1,
    previousExceptionId: null,
    ruleVersion: 'v0.1',
    configVersion: defaultConfiguration.version,
  };
  const ingest = vi.fn<DetectionService['ingest']>(async (_actor, request) => ({
    decision: evaluateException(
      request.input,
      now.toISOString(),
      request.configuration.thresholds,
    ),
    incident: null,
    reviewRequired: false,
  }));

  return { mapping, sample, read, project, monitor, incident, ingest };
}

describe('inventory monitoring', () => {
  it('exhausts pagination and verifies with fresh reads independently of detection evidence', async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce({
      ok: true,
      value: { items: [], nextCursor: 'page-2', completeness: 'complete' },
    });
    expect(
      (await f.monitor.check(context, { ingest: f.ingest })).decision.decision,
    ).toBe('clear');
    expect(f.read.mock.calls[1]![1].input.cursor).toBe('page-2');
    const detectionEvidence = f.ingest.mock.calls[0]![1].evidence.map(
      (item) => item.key,
    );
    const proof = await f.monitor.verifier.evaluate(context, f.incident);
    expect(proof.outcome).toBe('passed');
    expect(proof.evidence).toHaveLength(2);
    expect(
      proof.evidence.every((item) => !detectionEvidence.includes(item.key)),
    ).toBe(true);
    expect(f.read).toHaveBeenCalledTimes(5);
  });

  it.each(['partial', 'missing', 'duplicate', 'cursor-loop', 'outage'])(
    'leaves detection and resolution untouched for %s reads',
    async (failure) => {
      const f = fixture();
      const observation = f.sample(f.mapping.left);
      f.read.mockResolvedValue(
        failure === 'outage'
          ? {
              ok: false,
              error: {
                code: 'transient',
                effect: 'none',
                retry: 'after_delay',
              },
            }
          : {
              ok: true,
              value: {
                items:
                  failure === 'missing'
                    ? []
                    : failure === 'duplicate'
                      ? [observation, observation]
                      : [observation],
                nextCursor: failure === 'cursor-loop' ? 'same' : null,
                completeness: failure === 'partial' ? 'partial' : 'complete',
              },
            },
      );
      await expect(
        f.monitor.check(context, { ingest: f.ingest }),
      ).rejects.toThrow();
      expect(f.ingest).not.toHaveBeenCalled();
      await expect(
        f.monitor.verifier.evaluate(context, f.incident),
      ).rejects.toThrow();
    },
  );

  it.each(['stock', 'unit', 'location', 'stale', 'basis', 'projection'])(
    'does not verify when %s prevents agreement',
    async (change) => {
      const f = fixture();
      const observation = f.sample(f.mapping.left);
      if (change === 'stock') observation.data.available = '80';
      if (change === 'unit') observation.data.unit = 'box';
      if (change === 'location') observation.data.location.externalId = 'other';
      if (change === 'stale') observation.observedAt = '2026-09-23T01:00:00Z';
      if (change === 'basis') observation.data.availabilityBasis = 'unknown';
      if (change === 'projection') f.project.mockResolvedValue(false);
      f.read.mockResolvedValueOnce({
        ok: true,
        value: {
          items: [observation],
          nextCursor: null,
          completeness: 'complete',
        },
      });
      expect(
        (await f.monitor.verifier.evaluate(context, f.incident)).outcome,
      ).not.toBe('passed');
    },
  );

  it('rejects another incident scope before reading providers', async () => {
    const f = fixture();
    f.incident.subject.scope.reverse();
    await expect(
      f.monitor.verifier.evaluate(context, f.incident),
    ).rejects.toThrow('scope');
    expect(f.read).not.toHaveBeenCalled();
  });
});
