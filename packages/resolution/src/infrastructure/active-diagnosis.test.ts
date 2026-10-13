import { createHash, randomUUID } from 'node:crypto';

import type {
  CapabilityReader,
  InventorySnapshot,
  Observation,
} from '@luma/connections';
import type { DiagnosisInput } from '@luma/exceptions';
import { defaultConfiguration } from '@luma/exceptions';
import { expect, it, vi } from 'vitest';

import {
  type InventoryMapping,
  inventoryRequest,
} from '../application/detection.js';
import { testContext } from '../application/tenant-context.fixture.js';
import {
  activeDiagnosisPublication,
  planActiveDiagnosis,
} from './active-diagnosis.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const now = new Date('2026-10-13T00:00:00.000Z');

function fixture() {
  const tenantId = randomUUID();
  const context = testContext({ tenantId });
  const side = (provider: string) => ({
    source: {
      tenantId,
      connectionId: randomUUID(),
      provider,
      resource: 'sku' as const,
      externalId: 'sku',
      scopeKey: 'pool',
    },
    sku: { externalId: 'sku', scopeKey: '' },
    location: { externalId: 'pool', scopeKey: '' },
  });
  const mapping: InventoryMapping = {
    tenantId,
    version: 'mapping/1',
    publishedAt: now.toISOString(),
    skuId: randomUUID(),
    locationId: randomUUID(),
    left: side('jtl'),
    right: side('shopify'),
    authority: 'left',
    sellingSource: 'right',
  };
  const observation = (
    entry: typeof mapping.left,
    available: string,
  ): Observation<InventorySnapshot> => ({
    id: randomUUID(),
    source: entry.source,
    kind: 'snapshot',
    observedAt: now.toISOString(),
    sourceUpdatedAt: null,
    sourceRevision: 'r1',
    adapterVersion: `${entry.source.provider}/1`,
    schemaVersion: 1,
    data: {
      sku: entry.sku,
      location: entry.location,
      unit: 'each',
      onHand: available,
      reserved: '0',
      available,
      availabilityBasis: 'provider_reported',
    },
  });
  const left = observation(mapping.left, '4'),
    right = observation(mapping.right, '12');
  const request = inventoryRequest(
    context,
    {
      left,
      right,
      mapping,
      configuration: defaultConfiguration,
      complete: true,
      projectionCurrent: true,
    },
    hash,
  );
  const snapshot: DiagnosisInput = {
    exceptionId: randomUUID(),
    revision: 1,
    firstDetectedAt: now.toISOString(),
    reviewRequired: false,
    subject: {
      kind: 'sku',
      id: mapping.skuId,
      scope: [
        mapping.locationId,
        ...[
          mapping.left.source.connectionId,
          mapping.right.source.connectionId,
        ].sort(),
      ],
    },
    input: request.input,
    configuration: request.configuration,
    evidence: request.evidence,
  };
  const pages = [
    { items: [left], completeness: 'complete' as const, nextCursor: null },
    { items: [right], completeness: 'complete' as const, nextCursor: null },
  ];

  return { context, mapping, snapshot, pages };
}

it('selects only mapped inventory reads and installed versions, never model or source text selectors', async () => {
  const { context, mapping, snapshot } = fixture();
  const discover = vi.fn<CapabilityReader['discover']>().mockResolvedValue([
    {
      capability: 'inventory.read',
      version: '0',
      minimumRisk: 'low',
      idempotency: 'none',
      retry: { maxAttempts: 1, initialDelayMs: 0 },
    },
  ]);
  const plan = await planActiveDiagnosis(context, snapshot, { discover });
  expect(plan?.requests).toEqual(
    [mapping.left, mapping.right].map((entry) => ({
      connectionId: entry.source.connectionId,
      capability: 'inventory.read',
      version: '0',
      input: { limit: 10, sku: entry.sku, location: entry.location },
    })),
  );
  const missing = structuredClone(snapshot);
  missing.evidence = missing.evidence.filter(
    (item) => item.adapterVersion !== 'canonical-mapping-v1',
  );
  expect(await planActiveDiagnosis(context, missing, { discover })).toBeNull();
  expect(discover).toHaveBeenCalledTimes(2);
});

it('retains typed provenance and budgets, preserves partial-page uncertainty and cannot fabricate canonical freshness', () => {
  const { context, snapshot, pages } = fixture();
  const publication = activeDiagnosisPublication(
    context,
    snapshot,
    pages,
    now,
    hash,
  );
  expect(publication?.request.input.exceptionClass).toBe('inventory_mismatch');
  if (publication?.request.input.exceptionClass !== 'inventory_mismatch')
    throw new Error('Missing publication');
  expect(publication.request.input.facts.complete).toBe(true);
  expect(publication.request.input.facts.projectionCurrent).toBe(false);
  expect(publication.observations).toHaveLength(2);
  expect(publication.request.evidence.at(-1)?.facts).toMatchObject({
    calls: 2,
    maximumCalls: 2,
    modelCalls: 0,
    complete: true,
  });
  const partial = [
    { ...pages[0]!, completeness: 'partial' as const, nextCursor: 'next' },
    pages[1]!,
  ];
  const unclear = activeDiagnosisPublication(
    context,
    snapshot,
    partial,
    now,
    hash,
  );
  if (unclear?.request.input.exceptionClass !== 'inventory_mismatch')
    throw new Error('Missing partial publication');
  expect(unclear.request.input.facts.complete).toBe(false);
  expect(unclear.request.evidence.at(-1)?.facts.complete).toBe(false);
});

it('rejects foreign provenance, ambiguous targets and data expansion before publication', () => {
  const { context, snapshot, pages } = fixture();
  const foreign = structuredClone(pages);
  foreign[0]!.items[0]!.source.tenantId = randomUUID();
  expect(() =>
    activeDiagnosisPublication(context, snapshot, foreign, now, hash),
  ).toThrow(/foreign provenance/);
  const duplicated = structuredClone(pages);
  duplicated[0]!.items.push(duplicated[0]!.items[0]!);
  expect(
    activeDiagnosisPublication(context, snapshot, duplicated, now, hash),
  ).toBeNull();
  const expanded = structuredClone(pages);
  expanded[0]!.items = Array.from(
    { length: 101 },
    () => expanded[0]!.items[0]!,
  );
  expect(() =>
    activeDiagnosisPublication(context, snapshot, expanded, now, hash),
  ).toThrow(/bounded page/);
});
