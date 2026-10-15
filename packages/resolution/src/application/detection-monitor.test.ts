import type {
  AuthorityConnection,
  AuthorityOverrides,
  CapabilityRequest,
  FulfillmentSnapshot,
  InventorySnapshot,
  Observation,
  ReadCapability,
} from '@luma/connections';
import { authorityGroups, resolveAuthority } from '@luma/connections';
import type { DetectionRequest, Incident } from '@luma/exceptions';
import { defaultConfiguration, evaluateException } from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import type {
  DetectionSources,
  FulfillmentWork,
  StockFollowing,
  StockPosition,
  SyncStreamState,
} from './detection-monitor.js';
import { createDetectionMonitor } from './detection-monitor.js';
import { testContext } from './tenant-context.fixture.js';

const uuid = () => crypto.randomUUID();
const tenantId = uuid();
const context = testContext({ tenantId });
const now = new Date('2026-10-05T12:00:00Z');
const ago = (minutes: number) =>
  new Date(+now - minutes * 60_000).toISOString();
const connections = { erp: uuid(), de: uuid(), at: uuid(), other: uuid() };
const providers: Record<string, string> = {
  [connections.erp]: 'jtl',
  [connections.de]: 'shopify',
  [connections.at]: 'shopify',
  [connections.other]: 'utility',
};

/** A fake exception service that applies the real rules and closes cases on passed verification. */
function exceptionService(
  verifier: () => {
    evaluate(
      context: TenantContext,
      incident: Incident,
    ): Promise<{ outcome: string }>;
  },
) {
  const incidents: Incident[] = [];
  const ingested: DetectionRequest[] = [];
  const evidence = new Map<string, DetectionRequest['evidence']>();

  return {
    incidents,
    ingested,
    ingest: vi.fn(
      async (_context: TenantContext, request: DetectionRequest) => {
        ingested.push(request);
        const decision = evaluateException(
          request.input,
          now.toISOString(),
          request.configuration.thresholds,
        );
        if (decision.decision !== 'detect')
          return { decision, incident: null, reviewRequired: false };
        const facts = request.input.facts as {
          subjectId: string;
          connectionId?: string;
          capability?: string;
          canonicalLocationId?: string;
          connectionIds?: string[];
        };
        const scope =
          request.input.exceptionClass === 'sync_failure'
            ? [facts.capability!]
            : request.input.exceptionClass === 'inventory_mismatch'
              ? [
                  facts.canonicalLocationId!,
                  ...[...facts.connectionIds!].sort(),
                ]
              : request.input.exceptionClass === 'stock_sync_stall'
                ? [facts.connectionIds![0]!]
                : [facts.connectionId!];
        let incident = incidents.find(
          (item) =>
            item.state !== 'resolved' &&
            item.exceptionClass === request.input.exceptionClass &&
            item.subject.subjectId ===
              (request.input.exceptionClass === 'sync_failure'
                ? facts.connectionId
                : facts.subjectId) &&
            JSON.stringify(item.subject.scope) === JSON.stringify(scope),
        );
        if (!incident) {
          incident = {
            id: uuid(),
            tenantId,
            fingerprint: uuid(),
            exceptionClass: request.input.exceptionClass,
            subject: {
              ruleIdentity: {
                sync_failure: 'connection-read',
                stuck_fulfillment: 'fulfillment-progress',
                inventory_mismatch: 'available-stock',
                order_quantity_mismatch: 'order-line-quantity',
                stock_sync_stall: 'stock-sync-follow',
                workflow_failure: 'workflow-step',
              }[request.input.exceptionClass],
              subjectKind: {
                sync_failure: 'connection',
                stuck_fulfillment: 'fulfillment',
                inventory_mismatch: 'sku',
                order_quantity_mismatch: 'order',
                stock_sync_stall: 'connection',
                workflow_failure: 'workflow_run',
              }[request.input.exceptionClass],
              subjectId:
                request.input.exceptionClass === 'sync_failure'
                  ? facts.connectionId!
                  : facts.subjectId,
              scope,
            },
            severity: decision.severity,
            state: 'detected',
            firstDetectedAt: ago(1),
            lastDetectedAt: ago(1),
            occurrenceCount: 1,
            previousExceptionId: null,
            ruleVersion: 'v0.2',
            configVersion: request.configuration.version,
          };
          incidents.push(incident);
        }
        evidence.set(incident.id, [
          ...(evidence.get(incident.id) ?? []),
          ...request.evidence,
        ]);

        return { decision, incident, reviewRequired: false };
      },
    ),
    list: vi.fn(async () => structuredClone(incidents)),
    evidence: vi.fn(
      async (_context: TenantContext, id: string) => evidence.get(id) ?? [],
    ),
    verify: vi.fn(async (actor: TenantContext, id: string) => {
      const incident = incidents.find((item) => item.id === id)!;
      const result = await verifier().evaluate(actor, incident);
      if (result.outcome !== 'passed') return false;
      incident.state = 'resolved';

      return true;
    }),
  };
}

function fixture(
  overrides: {
    authorityOverrides?: AuthorityOverrides;
    streams?: SyncStreamState[];
    positions?: StockPosition[];
    work?: FulfillmentWork[];
    stock?: Record<string, string>;
    following?: StockFollowing[];
    fulfillment?: Partial<FulfillmentSnapshot>;
    /** When Luma first saw the stock sides disagree after they last agreed. */
    mismatchSince?: string;
  } = {},
) {
  const state = {
    mismatchSince: overrides.mismatchSince ?? null,
    authorityOverrides: overrides.authorityOverrides ?? {},
    authorityRevision: 0,
    streams: overrides.streams ?? [],
    positions: overrides.positions ?? [],
    work: overrides.work ?? [],
    stock: overrides.stock ?? {},
    following: overrides.following ?? [],
    fulfillment: overrides.fulfillment ?? {},
  };
  const sources: DetectionSources = {
    positionSources: vi.fn(async () => []),
    streams: vi.fn(async () => structuredClone(state.streams)),
    stockPositions: vi.fn<DetectionSources['stockPositions']>(
      async (_context, { include, limit }) =>
        state.positions
          .filter(
            (position) =>
              !include.length ||
              include.some(
                (item) =>
                  item.skuId === position.skuId &&
                  item.locationId === position.locationId,
              ) ||
              limit > 1,
          )
          .slice(0, limit),
    ),
    fulfillments: vi.fn<DetectionSources['fulfillments']>(
      async (_context, { include, limit }) =>
        state.work
          .filter(
            (item) =>
              limit > 1 ||
              include.some(
                (named) =>
                  named.fulfillmentId === item.fulfillmentId &&
                  named.connectionId === item.connectionId,
              ),
          )
          .slice(0, limit),
    ),
    stockFollowing: vi.fn<DetectionSources['stockFollowing']>(
      async (_context, { storefrontIds }) =>
        state.following.filter((item) =>
          storefrontIds.includes(item.storefrontId),
        ),
    ),
    stockAgreement: vi.fn<DetectionSources['stockAgreement']>(async () =>
      state.mismatchSince
        ? {
            agreedAt: ago(90),
            mismatchSince: state.mismatchSince,
            snapshotIds: [
              '00000000-0000-4000-8000-00000000000a',
              '00000000-0000-4000-8000-00000000000b',
            ],
          }
        : null,
    ),
  };
  const read = vi.fn(
    async (
      _context: TenantContext,
      request: CapabilityRequest<ReadCapability>,
    ) => {
      const provider = providers[request.connectionId]!;
      const base = {
        id: uuid(),
        kind: 'snapshot' as const,
        observedAt: now.toISOString(),
        sourceUpdatedAt: null,
        sourceRevision: null,
        adapterVersion: `${provider}/1`,
        schemaVersion: 1 as const,
      };
      if (request.capability === 'inventory.read') {
        const input = request.input as {
          sku: { externalId: string; scopeKey: string };
          location: { externalId: string; scopeKey: string };
        };
        const item: Observation<InventorySnapshot> = {
          ...base,
          source: {
            tenantId,
            connectionId: request.connectionId,
            provider,
            resource: 'sku',
            externalId: input.sku.externalId,
            scopeKey: input.location.externalId,
          },
          data: {
            sku: input.sku,
            location: input.location,
            unit: 'each',
            onHand: null,
            reserved: null,
            available: state.stock[request.connectionId] ?? '10',
            availabilityBasis: 'provider_reported',
          },
        };

        return {
          ok: true as const,
          value: {
            items: [item],
            nextCursor: null,
            completeness: 'complete' as const,
          },
        };
      }
      const work = state.work.find(
        (item) => item.connectionId === request.connectionId,
      )!;
      const item: Observation<FulfillmentSnapshot> = {
        ...base,
        source: work.source,
        data: {
          order: work.order,
          status: 'processing',
          lines: work.lines.map((orderLine) => ({
            orderLine,
            quantity: { amount: '1', unit: 'each' },
          })),
          lastProgressAt: ago(180),
          progressBasis: 'source_updated',
          failureCode: null,
          holds: [],
          ...state.fulfillment,
        },
      };

      return {
        ok: true as const,
        value: {
          items: [item],
          nextCursor: null,
          completeness: 'complete' as const,
        },
      };
    },
  );
  const exceptions = exceptionService(() => monitor.verifier);
  const project = vi.fn(async () => true);
  const diagnose = vi.fn(async () => undefined);
  const log = vi.fn();
  const monitor = createDetectionMonitor({
    sources,
    capabilities: { read: read as never },
    exceptions,
    diagnose,
    project,
    authority: {
      read: async () => {
        const sourceConnections: AuthorityConnection[] = [
          ...new Map(
            state.positions
              .flatMap((position) => position.sources)
              .map((source) => [source.connectionId, source]),
          ).values(),
        ].map((source) => ({
          id: source.connectionId,
          label: source.provider,
          category:
            source.provider === 'jtl'
              ? 'erp'
              : source.provider === 'shopify'
                ? 'storefront'
                : null,
          available: true,
          capabilities: ['inventory.read'],
        }));

        return {
          revision: state.authorityRevision,
          connections: sourceConnections,
          groups: authorityGroups.map((group) =>
            resolveAuthority(
              group,
              sourceConnections,
              state.authorityOverrides,
            ),
          ),
        };
      },
    },
    configuration: defaultConfiguration,
    hash: (value) => value,
    now: () => now,
    log,
  });

  return { state, sources, read, exceptions, project, diagnose, log, monitor };
}

const stream = (overrides: Partial<SyncStreamState> = {}): SyncStreamState => ({
  id: uuid(),
  connectionId: connections.erp,
  provider: 'jtl',
  capability: 'orders.read',
  active: true,
  accessLostAt: null,
  attempts: 0,
  errorCode: null,
  errorAt: null,
  failingSince: null,
  lastCompleteAt: ago(30),
  ...overrides,
});

const ref = (externalId: string, scopeKey = '') => ({ externalId, scopeKey });

function position(): StockPosition {
  const source = (
    connectionId: string,
    provider: string,
    sku: string,
    location: string,
  ) => ({
    connectionId,
    provider,
    sku: ref(sku),
    location: ref(location),
    mappedAt: ago(600),
    mappingIds: [uuid(), uuid()],
  });

  return {
    positionId: uuid(),
    skuId: uuid(),
    locationId: uuid(),
    sources: [
      source(connections.erp, 'jtl', '2', 'all-warehouses'),
      source(
        connections.de,
        'shopify',
        'gid://shopify/InventoryItem/1',
        'gid://shopify/Location/1',
      ),
      source(
        connections.at,
        'shopify',
        'gid://shopify/InventoryItem/2',
        'gid://shopify/Location/2',
      ),
      source(connections.other, 'utility', 'x', 'y'),
    ],
  };
}

function work(): FulfillmentWork {
  return {
    fulfillmentId: uuid(),
    connectionId: connections.de,
    provider: 'shopify',
    source: {
      tenantId,
      connectionId: connections.de,
      provider: 'shopify',
      resource: 'fulfillment',
      externalId: 'gid://shopify/FulfillmentOrder/7',
      scopeKey: '',
    },
    order: ref('gid://shopify/Order/7'),
    lines: [ref('gid://shopify/LineItem/7', 'gid://shopify/Order/7')],
    snapshotId: uuid(),
    observedAt: ago(170),
  };
}

describe('detection monitor', () => {
  it('opens a sync failure after the retry window and verifies it after a complete scan', async () => {
    const failing = stream({
      attempts: 5,
      errorCode: 'transient',
      errorAt: ago(1),
      failingSince: ago(20),
    });
    const f = fixture({
      streams: [failing, stream({ capability: 'products.read' })],
    });

    await f.monitor.tick(context);

    expect(f.exceptions.ingested).toHaveLength(1);
    expect(f.exceptions.ingested[0]!.input).toMatchObject({
      exceptionClass: 'sync_failure',
      facts: {
        connectionId: connections.erp,
        capability: 'orders.read',
        retryExhausted: true,
        firstFailureAt: failing.failingSince,
      },
    });
    expect(f.exceptions.incidents).toHaveLength(1);
    expect(f.diagnose).toHaveBeenCalledWith(
      context,
      f.exceptions.incidents[0]!.id,
    );

    // The same failure state is the same evidence; the case is not diagnosed again.
    await f.monitor.tick(context);
    expect(f.diagnose).toHaveBeenCalledTimes(1);

    f.state.streams[0] = {
      ...failing,
      attempts: 0,
      failingSince: null,
      lastCompleteAt: now.toISOString(),
    };
    await f.monitor.tick(context);

    expect(f.exceptions.verify).toHaveBeenCalledTimes(1);
    expect(f.exceptions.incidents[0]!.state).toBe('resolved');
  });

  it('verifies a recovered sync failure opened under an earlier configuration', async () => {
    const failing = stream({
      attempts: 5,
      errorCode: 'transient',
      errorAt: ago(1),
      failingSince: ago(20),
    });
    const f = fixture({ streams: [failing] });
    await f.monitor.tick(context);
    f.exceptions.incidents[0]!.configVersion = 'earlier';
    f.state.streams[0] = {
      ...failing,
      attempts: 0,
      failingSince: null,
      lastCompleteAt: now.toISOString(),
    };

    await f.monitor.tick(context);

    expect(f.exceptions.incidents[0]!.state).toBe('resolved');
  });

  it('opens one case when the provider revokes access and verifies it after reconnecting', async () => {
    const lost = { active: false, accessLostAt: ago(2) };
    const f = fixture({
      streams: [
        stream(lost),
        stream({ ...lost, capability: 'products.read' }),
        // A connection a person disconnected stays clear.
        stream({ connectionId: connections.de, active: false }),
      ],
    });

    await f.monitor.tick(context);
    await f.monitor.tick(context);

    expect(f.exceptions.incidents).toHaveLength(1);
    expect(f.exceptions.incidents[0]).toMatchObject({
      state: 'detected',
      subject: { subjectId: connections.erp, scope: ['orders.read'] },
    });
    expect(f.diagnose).toHaveBeenCalledTimes(1);

    f.state.streams[0] = {
      ...f.state.streams[0]!,
      active: true,
      accessLostAt: null,
      lastCompleteAt: now.toISOString(),
    };
    await f.monitor.tick(context);

    expect(f.exceptions.incidents[0]!.state).toBe('resolved');
  });

  it('keeps a sync failure open while the stream has not completed a scan since detection', async () => {
    const f = fixture({
      streams: [
        stream({
          attempts: 5,
          errorCode: 'timeout',
          errorAt: ago(1),
          failingSince: ago(30),
        }),
      ],
    });
    await f.monitor.tick(context);
    f.state.streams[0] = {
      ...f.state.streams[0]!,
      attempts: 0,
      failingSince: null,
      lastCompleteAt: ago(60),
    };

    await f.monitor.tick(context);

    expect(f.exceptions.incidents[0]!.state).toBe('detected');
  });

  it('compares the selected selling source with the ERP from fresh reads and confirms the projection', async () => {
    const linked = position();
    const f = fixture({
      positions: [linked],
      authorityOverrides: { inventory_selling: connections.at },
      stock: {
        [connections.erp]: '12',
        [connections.de]: '12',
        [connections.at]: '9',
      },
    });

    await f.monitor.tick(context);

    const compared = f.exceptions.ingested.map(
      (request) => request.input.facts,
    );
    expect(compared).toHaveLength(2);
    expect(compared).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectionIds: [connections.erp, connections.de],
          authority: null,
          sellingSource: 'right',
        }),
        expect.objectContaining({
          connectionIds: [connections.erp, connections.at],
        }),
      ]),
    );
    expect(f.project).toHaveBeenCalledWith(
      context,
      expect.anything(),
      linked.positionId,
    );
    expect(f.exceptions.incidents).toHaveLength(1);
    expect(f.exceptions.incidents[0]!.subject.scope).toEqual([
      linked.locationId,
      ...[connections.erp, connections.at].sort(),
    ]);

    f.state.stock[connections.at] = '12';
    await f.monitor.tick(context);

    expect(f.exceptions.incidents[0]!.state).toBe('resolved');
  });

  it('waits for sync on a gap Luma saw open recently, unless the storefront oversells', async () => {
    const f = fixture({
      positions: [position()],
      authorityOverrides: { inventory_selling: connections.at },
      mismatchSince: ago(2),
      stock: {
        [connections.erp]: '100',
        [connections.de]: '100',
        [connections.at]: '101',
      },
    });
    // The storefront that sells is compared with the ERP's stock authority.
    const latest = () => {
      const request = [...f.exceptions.ingested]
        .reverse()
        .find(
          (item) =>
            item.input.exceptionClass === 'inventory_mismatch' &&
            item.input.facts.connectionIds[1] === connections.at,
        )!;

      return {
        facts: request.input.facts,
        decision: evaluateException(
          request.input,
          now.toISOString(),
          defaultConfiguration.thresholds,
        ),
      };
    };

    await f.monitor.tick(context);

    expect(f.exceptions.incidents).toHaveLength(0);
    expect(latest()).toMatchObject({
      facts: { authority: 'left', mismatchSince: ago(2) },
      decision: { decision: 'defer', reason: 'propagation_pending' },
    });

    // A storefront selling ten times the ERP's stock is raised without waiting.
    f.state.stock = {
      [connections.erp]: '30',
      [connections.de]: '30',
      [connections.at]: '300',
    };
    await f.monitor.tick(context);

    expect(latest().decision).toMatchObject({
      decision: 'detect',
      reason: 'oversell_risk',
    });
    expect(f.exceptions.incidents).toHaveLength(1);

    // A gap open longer than the propagation window is raised as well.
    f.state.stock[connections.erp] = '100';
    f.state.stock[connections.at] = '101';
    f.state.mismatchSince = ago(31);
    await f.monitor.tick(context);

    expect(latest()).toMatchObject({
      facts: { mismatchSince: ago(31) },
      decision: { decision: 'detect', reason: 'oversell_risk' },
    });
    expect(f.exceptions.incidents).toHaveLength(1);
  });

  it('defers conflicting authority, applies overrides on the next pass and keeps prior evidence intact', async () => {
    const f = fixture({
      positions: [position()],
      stock: {
        [connections.erp]: '4',
        [connections.de]: '12',
        [connections.at]: '12',
      },
    });
    await f.monitor.tick(context);
    expect(f.exceptions.incidents).toHaveLength(0);
    expect(
      f.exceptions.ingested.every(
        (request) =>
          evaluateException(
            request.input,
            now.toISOString(),
            defaultConfiguration.thresholds,
          ).decision === 'defer',
      ),
    ).toBe(true);
    const previous = structuredClone(f.exceptions.ingested);
    f.state.authorityOverrides = { inventory_selling: connections.de };
    f.state.authorityRevision = 1;
    await f.monitor.tick(context);
    expect(f.exceptions.incidents).toHaveLength(1);
    expect(f.exceptions.ingested.slice(0, previous.length)).toEqual(previous);
    expect(
      f.exceptions.ingested
        .at(-2)!
        .evidence.find((item) => item.key.startsWith('mapping:'))!.facts,
    ).toMatchObject({ sourceAuthority: { revision: 1 } });
    const incident = f.exceptions.incidents[0]!;
    f.state.authorityOverrides.inventory_stock = connections.other;
    f.state.authorityRevision = 2;
    await f.monitor.tick(context);
    expect(await f.monitor.verifier.evaluate(context, incident)).toMatchObject({
      outcome: 'inconclusive',
      authoritative: false,
    });
    expect(incident.state).toBe('detected');
  });

  it('opens a stuck fulfillment from a fresh read and closes it when the work ships', async () => {
    const stalled = work();
    const f = fixture({ work: [stalled] });

    await f.monitor.tick(context);

    expect(f.read).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        capability: 'fulfillment.read',
        input: { limit: 100, order: stalled.order },
      }),
    );
    expect(f.exceptions.incidents).toHaveLength(1);
    expect(f.exceptions.incidents[0]).toMatchObject({
      exceptionClass: 'stuck_fulfillment',
      subject: { subjectId: stalled.fulfillmentId, scope: [connections.de] },
    });

    f.state.fulfillment = { status: 'shipped', lastProgressAt: ago(1) };
    await f.monitor.tick(context);

    expect(f.exceptions.incidents[0]!.state).toBe('resolved');
  });

  it('treats held work as exempt instead of stuck', async () => {
    const f = fixture({
      work: [work()],
      fulfillment: { holds: [{ reason: 'high_risk_of_fraud' }] },
    });

    await f.monitor.tick(context);

    expect(f.exceptions.ingested[0]!.input.facts).toMatchObject({
      eligibility: 'exempt',
    });
    expect(f.exceptions.incidents).toHaveLength(0);
  });

  it('counts a hold as the cause once the work has not progressed for a day', async () => {
    const f = fixture({
      work: [work()],
      fulfillment: {
        holds: [{ reason: 'high_risk_of_fraud' }],
        lastProgressAt: ago(25 * 60),
      },
    });

    await f.monitor.tick(context);

    expect(f.exceptions.incidents).toHaveLength(1);
    expect(f.exceptions.incidents[0]).toMatchObject({
      exceptionClass: 'stuck_fulfillment',
    });
  });

  it('runs every rule even when one source is unavailable', async () => {
    const f = fixture({ work: [work()] });
    vi.mocked(f.sources.streams).mockRejectedValueOnce(
      new Error('database busy'),
    );

    await f.monitor.tick(context);

    expect(f.log).toHaveBeenCalledWith(
      'Sync failure detection could not complete; retrying next pass.',
      expect.any(Error),
    );
    expect(f.exceptions.incidents).toHaveLength(1);
  });

  describe('stalled stock sync', () => {
    /** Three linked products whose ERP stock changed 40 minutes ago, with healthy stock reads. */
    function stalled(
      overrides: {
        followed?: number;
        streams?: SyncStreamState[];
        stock?: Record<string, string>;
        authorityOverrides?: AuthorityOverrides;
      } = {},
    ) {
      const positions = [position(), position(), position()];
      const following: StockFollowing = {
        storefrontId: connections.de,
        followed: overrides.followed ?? 0,
        lagging: positions.length,
        laggingSince: ago(40),
        positions: positions.map((item) => ({
          positionId: item.positionId,
          skuId: item.skuId,
          locationId: item.locationId,
          changedAt: ago(40),
        })),
      };
      const reads = (connectionId: string, provider: string) =>
        stream({
          connectionId,
          provider,
          capability: 'inventory.read',
          lastCompleteAt: ago(2),
        });

      return fixture({
        positions,
        following: [following],
        ...(overrides.authorityOverrides
          ? { authorityOverrides: overrides.authorityOverrides }
          : {}),
        stock: overrides.stock ?? {
          [connections.erp]: '5',
          [connections.de]: '9',
        },
        streams: overrides.streams ?? [
          reads(connections.erp, 'jtl'),
          reads(connections.de, 'shopify'),
        ],
      });
    }

    const stalls = (f: ReturnType<typeof fixture>) =>
      f.exceptions.incidents.filter(
        (item) => item.exceptionClass === 'stock_sync_stall',
      );
    const stallRequests = (f: ReturnType<typeof fixture>) =>
      f.exceptions.ingested.filter(
        (item) => item.input.exceptionClass === 'stock_sync_stall',
      );

    it('opens one case for the storefront when its lagging products still differ on fresh reads', async () => {
      const f = stalled();

      await f.monitor.tick(context);

      expect(stalls(f)).toEqual([
        expect.objectContaining({
          severity: 'high',
          subject: {
            ruleIdentity: 'stock-sync-follow',
            subjectKind: 'connection',
            subjectId: connections.de,
            scope: [connections.erp],
          },
        }),
      ]);
      expect(stallRequests(f)[0]!.input.facts).toMatchObject({
        lagging: 3,
        sampled: 3,
        confirmed: 3,
        overselling: 3,
        readsCurrent: true,
      });
      expect(f.diagnose).toHaveBeenCalledWith(context, stalls(f)[0]!.id);
      // The storefront that reported no unfollowed changes is not evaluated.
      expect(
        stallRequests(f).some(
          (item) => item.input.facts.subjectId === connections.at,
        ),
      ).toBe(false);
    });

    it('leaves a store whose recent changes mostly arrived to per-product checks', async () => {
      const f = stalled({ followed: 10 });

      await f.monitor.tick(context);

      // Nothing is reread or evaluated for a store whose sync visibly works.
      expect(stallRequests(f)).toEqual([]);
      expect(stalls(f)).toEqual([]);
    });

    it('starts no evaluation while Luma’s own stock reads are failing', async () => {
      const f = stalled({
        streams: [
          stream({
            connectionId: connections.de,
            provider: 'shopify',
            capability: 'inventory.read',
            attempts: 2,
            failingSince: ago(10),
          }),
        ],
      });

      await f.monitor.tick(context);

      expect(stallRequests(f)).toEqual([]);
      expect(stalls(f)).toEqual([]);
    });

    it('lets the products of a stalled store wait instead of opening one case each, unless they oversell', async () => {
      const f = stalled({
        stock: { [connections.erp]: '5', [connections.de]: '4' },
        authorityOverrides: { inventory_selling: connections.de },
      });
      const mismatches = () =>
        f.exceptions.incidents.filter(
          (item) =>
            item.exceptionClass === 'inventory_mismatch' &&
            item.subject.scope.includes(connections.de),
        );

      await f.monitor.tick(context);

      expect(stalls(f)).toHaveLength(1);
      expect(mismatches()).toEqual([]);
      const waiting = f.exceptions.ingested.filter(
        (item) =>
          item.input.exceptionClass === 'inventory_mismatch' &&
          item.input.facts.syncStalled,
      );
      expect(waiting.length).toBeGreaterThan(0);
      expect(
        waiting.every((item) =>
          item.evidence.some(
            (evidence) =>
              evidence.key === `stock-sync-stall:${stalls(f)[0]!.id}`,
          ),
        ),
      ).toBe(true);

      // Without the stall case the same gap opens its own case.
      const control = fixture({
        positions: f.state.positions,
        stock: { [connections.erp]: '5', [connections.de]: '4' },
        authorityOverrides: { inventory_selling: connections.de },
      });
      await control.monitor.tick(context);
      expect(
        control.exceptions.incidents.some(
          (item) => item.exceptionClass === 'inventory_mismatch',
        ),
      ).toBe(true);

      // A storefront that shows more than the ERP has still opens its own case.
      f.state.stock[connections.de] = '9';
      await f.monitor.tick(context);
      expect(mismatches().length).toBeGreaterThan(0);
    });

    it('closes the case only when the products that lagged match on fresh reads', async () => {
      const f = stalled({
        stock: { [connections.erp]: '5', [connections.de]: '4' },
      });
      await f.monitor.tick(context);
      expect(stalls(f)).toHaveLength(1);
      expect(stalls(f)[0]!.severity).toBe('medium');

      // No stored changes are unfollowed any more, but the storefront still shows other figures.
      f.state.following = [];
      await f.monitor.tick(context);
      expect(stalls(f)[0]!.state).not.toBe('resolved');

      f.state.stock[connections.de] = '5';
      await f.monitor.tick(context);
      expect(stalls(f)[0]!.state).toBe('resolved');
    });
  });
});
