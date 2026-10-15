import type { DetectionRequest, Incident } from '@luma/exceptions';
import { defaultConfiguration, evaluateException } from '@luma/exceptions';
import { describe, expect, it, vi } from 'vitest';

import type {
  DetectionSources,
  OrderQuantities,
  OrderQuantitySources,
} from './detection-monitor.js';
import { createDetectionMonitor } from './detection-monitor.js';
import { testContext } from './tenant-context.fixture.js';

const uuid = () => crypto.randomUUID();
const tenantId = uuid();
const context = testContext({ tenantId });
const now = new Date('2026-10-05T12:00:00Z');
const ago = (minutes: number) =>
  new Date(+now - minutes * 60_000).toISOString();
const orderId = uuid();
const lineKey = uuid();
const erp = uuid(),
  jtl = uuid(),
  shop = uuid();

/** Each source's current units; reads are taken by `refresh` and stamped with `readAt`. */
function fixture(
  quantities: Record<string, string | null>,
  changedAt = ago(40),
) {
  const state = { quantities, changedAt, readAt: ago(50), reads: 0 };
  const read = (): OrderQuantities => ({
    orderId,
    complete: true,
    changedAt: state.changedAt,
    oldestReadAt: state.readAt,
    latestReadAt: state.readAt,
    authority: { state: 'resolved', connectionId: erp, revision: 3 },
    lines: [
      {
        lineKey,
        unit: 'each',
        sources: [erp, jtl, shop].map((connectionId) => ({
          connectionId,
          provider:
            connectionId === erp
              ? 'luma-erp'
              : connectionId === jtl
                ? 'jtl'
                : 'shopify',
          order: { externalId: `order-${connectionId}`, scopeKey: '' },
          sourceUpdatedAt: null,
          quantity: state.quantities[connectionId] ?? null,
          evidence: [
            {
              snapshotId: `${connectionId}-${state.reads}`,
              observationId: `observation-${connectionId}-${state.reads}`,
              observedAt: state.readAt,
            },
          ],
        })),
      },
    ],
  });
  const orders: OrderQuantitySources = {
    candidates: vi.fn(async () => [orderId]),
    quantities: vi.fn(async () => read()),
    refresh: vi.fn(async (_context, _orderId, maxAgeMs: number) => {
      // Sources older than `maxAgeMs` are read again now.
      if (+now - Date.parse(state.readAt) >= maxAgeMs) {
        state.readAt = now.toISOString();
        state.reads++;
      }
    }),
  };
  const incidents: Incident[] = [];
  const ingested: DetectionRequest[] = [];
  const exceptions = {
    ingest: vi.fn(async (_actor: unknown, request: DetectionRequest) => {
      ingested.push(request);
      const decision = evaluateException(
        request.input,
        now.toISOString(),
        request.configuration.thresholds,
      );
      if (decision.decision !== 'detect')
        return { decision, incident: null, reviewRequired: false };
      const facts = request.input.facts as {
        lineKey: string;
        connectionIds: string[];
      };
      let incident = incidents.find((item) => item.state !== 'resolved');
      incident ??=
        incidents[
          incidents.push({
            id: uuid(),
            tenantId,
            fingerprint: uuid(),
            exceptionClass: 'order_quantity_mismatch',
            subject: {
              ruleIdentity: 'order-line-quantity',
              subjectKind: 'order',
              subjectId: orderId,
              scope: [facts.lineKey, ...[...facts.connectionIds].sort()],
            },
            severity: decision.severity,
            state: 'detected',
            firstDetectedAt: now.toISOString(),
            lastDetectedAt: now.toISOString(),
            occurrenceCount: 1,
            previousExceptionId: null,
            ruleVersion: 'v0.2',
            configVersion: request.configuration.version,
          }) - 1
        ]!;

      return { decision, incident, reviewRequired: false };
    }),
    list: vi.fn(async () => structuredClone(incidents)),
    evidence: vi.fn(async () => []),
    verify: vi.fn(async (actor: typeof context, id: string) => {
      const incident = incidents.find((item) => item.id === id)!;
      const result = await monitor.verifier.evaluate(actor, incident);
      verified.push(result);
      if (result.outcome !== 'passed') return false;
      incident.state = 'resolved';

      return true;
    }),
  };
  const verified: Awaited<ReturnType<typeof monitor.verifier.evaluate>>[] = [];
  const sources = {
    streams: vi.fn(async () => []),
    stockPositions: vi.fn(async () => []),
    fulfillments: vi.fn(async () => []),
  } as unknown as DetectionSources;
  const diagnose = vi.fn(async () => undefined);
  const monitor = createDetectionMonitor({
    sources,
    orders,
    capabilities: { read: vi.fn() as never },
    exceptions,
    diagnose,
    project: vi.fn(async () => true),
    authority: { read: vi.fn() as never },
    configuration: defaultConfiguration,
    hash: (value) => `hash-${value.length}-${value.slice(-12)}`,
    now: () => now,
  });

  return {
    state,
    orders,
    incidents,
    ingested,
    verified,
    diagnose,
    tick: () => monitor.tick(context),
  };
}

describe('order line quantity detection', () => {
  it('rereads sources read before the window ended, then opens one case across every source', async () => {
    const f = fixture({ [erp]: '1', [jtl]: null, [shop]: '2' });
    await f.tick();

    expect(f.orders.refresh).toHaveBeenCalledWith(context, orderId, 60_000);
    expect(f.incidents).toHaveLength(1);
    expect(f.incidents[0]!.subject.scope).toEqual([
      lineKey,
      ...[erp, jtl, shop].sort(),
    ]);
    expect(f.diagnose).toHaveBeenCalledWith(context, f.incidents[0]!.id);
    const [request] = f.ingested;
    expect(request!.input.facts).toMatchObject({
      authorityConnectionId: erp,
      quantities: expect.arrayContaining([
        { connectionId: jtl, quantity: null },
      ]),
      oldestReadAt: now.toISOString(),
    });
    // One evidence item per source read, and one naming the whole comparison.
    expect(request!.evidence.map((item) => item.connectionId).sort()).toEqual(
      [erp, jtl, shop, null].sort(),
    );
  });

  it('lets a recent change wait for propagation without opening a case', async () => {
    const f = fixture({ [erp]: '1', [jtl]: null, [shop]: '2' }, ago(10));
    await f.tick();

    expect(f.incidents).toHaveLength(0);
    expect(f.ingested.at(-1)?.input.exceptionClass).toBe(
      'order_quantity_mismatch',
    );
  });

  it('verifies an open case only with reads taken after its detection, never counting a source that does not report', async () => {
    const f = fixture({ [erp]: '1', [jtl]: null, [shop]: '2' });
    await f.tick();
    const detected = f.ingested[0]!.evidence.map((item) => item.key);
    f.state.quantities[shop] = '1';
    await f.tick();

    expect(f.incidents[0]!.state).toBe('resolved');
    const proof = f.verified.at(-1)!;
    expect(proof).toMatchObject({
      outcome: 'passed',
      complete: true,
      authoritative: true,
    });
    expect(proof.evidence.every((item) => !detected.includes(item.key))).toBe(
      true,
    );
    expect(
      proof.bindings.every(
        (binding) =>
          binding.postcondition === 'workflow_business_postcondition_verified',
      ),
    ).toBe(true);
    expect(
      proof.evidence.find((item) => item.connectionId === jtl)?.facts.quantity,
    ).toBeNull();
  });
});
