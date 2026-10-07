import type {
  CapabilityReader,
  ExternalId,
  FulfillmentSnapshot,
  InventorySnapshot,
  Observation,
  SourceIdentity,
} from '@luma/connections';
import type {
  Configuration,
  DetectionService,
  Evidence,
  Facts,
  Incident,
  VerificationEvaluator,
  VerificationResult,
} from '@luma/exceptions';
import { evaluateException } from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
import { requireRole } from '@luma/identity';

import type { FulfillmentMapping, InventoryMapping } from './detection.js';
import { fulfillmentRequest } from './detection.js';
import { createInventoryMonitor } from './inventory-monitor.js';

type SyncCapability = Facts<'sync_failure'>['capability'];

type SyncErrorCode = NonNullable<Facts<'sync_failure'>['errorCode']>;

/** Durable sync state of one connection's record stream, as the sync runner stored it. */
export interface SyncStreamState {
  id: string;
  connectionId: string;
  provider: string;
  capability: SyncCapability;
  /** The connection is active and the stream is neither paused nor blocked. */
  active: boolean;
  attempts: number;
  errorCode: string | null;
  errorAt: string | null;
  failingSince: string | null;
  lastCompleteAt: string | null;
}

/** One connection's current stock report for a canonical stock position. */
export interface StockSource {
  connectionId: string;
  provider: string;
  /** Exactly one source mapping for each of the position's SKU and location. */
  sku: ExternalId;
  location: ExternalId;
  /** When the SKU and location mappings were last changed. */
  mappedAt: string;
  mappingIds: string[];
}

/** A stock position reported by at least two connections that people linked. */
export interface StockPosition {
  positionId: string;
  skuId: string;
  locationId: string;
  sources: StockSource[];
}

/** An open fulfillment as last imported, with the references its import mapped. */
export interface FulfillmentWork {
  fulfillmentId: string;
  connectionId: string;
  provider: string;
  source: SourceIdentity;
  order: ExternalId;
  lines: ExternalId[];
  /** The stored snapshot whose references form the mapping. */
  snapshotId: string;
  observedAt: string;
}

/** Tenant-scoped reads of stored sync, stock and fulfillment state. */
export interface DetectionSources {
  streams(context: TenantContext): Promise<SyncStreamState[]>;
  /**
   * Positions whose stored reports disagree, plus the positions named in `include`, most
   * recently observed first.
   */
  stockPositions(
    context: TenantContext,
    options: {
      include: { skuId: string; locationId: string }[];
      limit: number;
    },
  ): Promise<StockPosition[]>;
  /**
   * Open fulfillments without progress since `before`, plus the fulfillments named in
   * `include`, oldest progress first.
   */
  fulfillments(
    context: TenantContext,
    options: {
      before: string;
      include: { fulfillmentId: string; connectionId: string }[];
      limit: number;
    },
  ): Promise<FulfillmentWork[]>;
}

export interface DetectionMonitorOptions {
  sources: DetectionSources;
  capabilities: Pick<CapabilityReader, 'read'>;
  exceptions: Pick<DetectionService, 'ingest' | 'list' | 'verify'>;
  /** Prepares a diagnosis for a newly detected case so people see its cause and options. */
  diagnose?(context: TenantContext, exceptionId: string): Promise<unknown>;
  /** Records a fresh stock read and reports whether it is now the source's current projection. */
  project(
    context: TenantContext,
    observation: Observation<InventorySnapshot>,
    positionId: string,
  ): Promise<boolean>;
  /** Whether a provider is an ERP or a storefront; others are not compared. */
  category(provider: string): 'erp' | 'storefront' | null;
  configuration: Configuration;
  hash(value: string): string;
  /** Fresh stock and fulfillment checks per workspace and pass. */
  limits?: { stock?: number; fulfillment?: number };
  /**
   * How long a hold may explain missing progress. After it, the hold counts as the reason the
   * order is stuck. Defaults to 24 hours.
   */
  holdOverdueSeconds?: number;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

const syncErrorCodes: readonly string[] = [
  'authentication',
  'permission_denied',
  'invalid_response',
  'unsupported_capability',
  'unsupported_version',
  'transient',
  'timeout',
  'rate_limited',
  'internal',
  'unavailable',
  'invalid_input',
  'not_found',
  'conflict',
] satisfies SyncErrorCode[];

/** Consecutive failed pages after which the sync runner reports a stream as failing. */
const failingAfterAttempts = 5;

const open = (incident: Incident) => incident.state !== 'resolved';

/**
 * Detects and verifies operational issues from data Luma already imports. Each pass reads
 * stored sync, stock and fulfillment state to choose candidates, then confirms them with
 * fresh provider reads before evaluating the exception rules. Clear results never close a
 * case; the case is closed only by independent verification.
 */
export function createDetectionMonitor(options: DetectionMonitorOptions) {
  const { sources, capabilities, exceptions, configuration, hash } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const limits = {
    stock: options.limits?.stock ?? 25,
    fulfillment: options.limits?.fulfillment ?? 25,
  };
  const holdOverdueSeconds = options.holdOverdueSeconds ?? 86_400;

  /** Pairs every ERP report with every storefront report of the same position. */
  function stockMappings(
    context: TenantContext,
    position: StockPosition,
  ): InventoryMapping[] {
    const side = (source: StockSource) => ({
      source: {
        tenantId: context.tenantId,
        connectionId: source.connectionId,
        provider: source.provider,
        resource: 'sku' as const,
        externalId: source.sku.externalId,
        scopeKey: source.location.externalId,
      },
      sku: source.sku,
      location: source.location,
    });
    const of = (category: 'erp' | 'storefront') =>
      position.sources.filter(
        (source) => options.category(source.provider) === category,
      );

    return of('erp').flatMap((erp) =>
      of('storefront').map((store) => ({
        tenantId: context.tenantId,
        version: hash(
          JSON.stringify([...erp.mappingIds, ...store.mappingIds].sort()),
        ),
        publishedAt: [erp.mappedAt, store.mappedAt].sort().at(-1)!,
        skuId: position.skuId,
        locationId: position.locationId,
        left: side(erp),
        right: side(store),
        authority: 'left' as const,
        sellingSource: 'right' as const,
      })),
    );
  }

  function inventoryMonitor(mapping: InventoryMapping, positionId: string) {
    return createInventoryMonitor({
      capabilities,
      mapping,
      configuration,
      hash,
      now,
      project: (context, observation) =>
        options.project(context, observation, positionId),
    });
  }

  async function stockMapping(context: TenantContext, incident: Incident) {
    const [locationId, ...connections] = incident.subject.scope;
    const [position] = await sources.stockPositions(context, {
      include: [{ skuId: incident.subject.subjectId, locationId: locationId! }],
      limit: 1,
    });
    const mapping = position
      ? stockMappings(context, position).find(
          (candidate) =>
            JSON.stringify(
              [
                candidate.left.source.connectionId,
                candidate.right.source.connectionId,
              ].sort(),
            ) === JSON.stringify(connections),
        )
      : undefined;

    return mapping && position
      ? { mapping, positionId: position.positionId }
      : null;
  }

  async function readFulfillment(
    context: TenantContext,
    work: FulfillmentWork,
  ) {
    const result = await capabilities.read(context, {
      connectionId: work.connectionId,
      capability: 'fulfillment.read',
      version: '0',
      input: { limit: 100, order: work.order },
    });
    if (!result.ok)
      throw new Error(`Fulfillment read failed: ${result.error.code}`);
    const matches = result.value.items.filter(
      (item) =>
        item.source.connectionId === work.source.connectionId &&
        item.source.resource === work.source.resource &&
        item.source.externalId === work.source.externalId &&
        item.source.scopeKey === work.source.scopeKey,
    ) as Observation<FulfillmentSnapshot>[];

    return {
      observation: matches.length === 1 ? matches[0]! : null,
      complete: result.value.completeness === 'complete',
    };
  }

  function fulfillmentInput(
    context: TenantContext,
    work: FulfillmentWork,
    observation: Observation<FulfillmentSnapshot>,
    complete: boolean,
  ) {
    const mapping: FulfillmentMapping = {
      tenantId: context.tenantId,
      version: work.snapshotId,
      publishedAt: work.observedAt,
      fulfillmentId: work.fulfillmentId,
      source: work.source,
      order: work.order,
      lines: work.lines,
    };
    const { holds, fulfillAt, lastProgressAt } = observation.data;
    // A hold explains missing progress until it is overdue; then the hold is why it is stuck.
    const holdOverdue =
      !!holds?.length &&
      lastProgressAt !== null &&
      Date.parse(observation.observedAt) - Date.parse(lastProgressAt) >=
        holdOverdueSeconds * 1000;
    // Holds and a later scheduled start explain missing progress; unread holds stay unknown.
    const eligibility =
      holds === undefined
        ? ('unknown' as const)
        : (holds.length && !holdOverdue) ||
            (fulfillAt &&
              Date.parse(fulfillAt) > Date.parse(observation.observedAt))
          ? ('exempt' as const)
          : ('eligible' as const);
    const { tenantId, connectionId, ...source } = observation.source;
    const eligibilityEvidence: Evidence = {
      key: `eligibility:${observation.id}`,
      tenantId,
      connectionId,
      source,
      observedAt: observation.observedAt,
      sourceUpdatedAt: observation.sourceUpdatedAt,
      adapterVersion: observation.adapterVersion,
      schemaVersion: 1,
      facts: {
        eligibility,
        holds: holds?.map((hold) => hold.reason) ?? null,
        holdOverdue,
        fulfillAt: fulfillAt ?? null,
      },
    };

    return {
      observation,
      mapping,
      complete,
      eligibility,
      eligibilityEvidence,
      configuration,
    };
  }

  function syncEvent(
    context: TenantContext,
    stream: SyncStreamState,
  ): Evidence {
    return {
      key: `sync-stream:${stream.id}:${stream.failingSince}:${stream.attempts}`,
      tenantId: context.tenantId,
      connectionId: stream.connectionId,
      source: {
        provider: stream.provider,
        resource: 'sync_stream',
        externalId: stream.id,
        scopeKey: stream.capability,
      },
      observedAt: stream.errorAt ?? now().toISOString(),
      sourceUpdatedAt: null,
      adapterVersion: 'commerce-sync-v1',
      schemaVersion: 1,
      facts: {
        attempts: stream.attempts,
        errorCode: stream.errorCode,
        failingSince: stream.failingSince,
        lastCompleteAt: stream.lastCompleteAt,
      },
    };
  }

  async function syncFailures(context: TenantContext, incidents: Incident[]) {
    for (const stream of await sources.streams(context)) {
      const incident = incidents.find(
        (item) =>
          item.exceptionClass === 'sync_failure' &&
          item.subject.subjectId === stream.connectionId &&
          item.subject.scope[0] === stream.capability,
      );
      if (stream.attempts > 0 && stream.failingSince) {
        const errorCode = (
          syncErrorCodes.includes(stream.errorCode ?? '')
            ? stream.errorCode
            : 'internal'
        ) as SyncErrorCode;
        const event = syncEvent(context, stream);
        const result = await exceptions.ingest(context, {
          key: hash(JSON.stringify(['scan', stream.connectionId, event.key])),
          input: {
            exceptionClass: 'sync_failure',
            facts: {
              tenantId: context.tenantId,
              evidenceTenantId: context.tenantId,
              subjectId: stream.connectionId,
              evidenceRefs: [event.key],
              connectionId: stream.connectionId,
              capability: stream.capability,
              active: stream.active,
              status: 'failed',
              errorCode,
              firstFailureAt: stream.failingSince,
              retryExhausted: stream.attempts >= failingAfterAttempts,
              scanComplete: false,
            },
          },
          configuration,
          evidence: [event],
        });
        await diagnoseNew(context, result, incident);
      } else if (incident && stream.active) await verify(context, incident);
    }
  }

  async function stock(context: TenantContext, incidents: Incident[]) {
    const tracked = incidents.filter(
      (item) => item.exceptionClass === 'inventory_mismatch',
    );
    const positions = await sources.stockPositions(context, {
      include: tracked.map((item) => ({
        skuId: item.subject.subjectId,
        locationId: item.subject.scope[0]!,
      })),
      limit: limits.stock,
    });
    for (const position of positions)
      for (const mapping of stockMappings(context, position)) {
        const monitor = inventoryMonitor(mapping, position.positionId);
        const incident = tracked.find(monitor.matches);
        try {
          const result = await monitor.check(context, exceptions);
          if (result.decision.decision === 'detect')
            await diagnoseNew(context, result, incident);
          else if (result.decision.decision === 'clear' && incident)
            await verify(context, incident);
        } catch (error) {
          log(
            'A stock check could not complete; it runs again next pass.',
            error,
          );
        }
      }
  }

  async function fulfillments(context: TenantContext, incidents: Incident[]) {
    const tracked = incidents.filter(
      (item) => item.exceptionClass === 'stuck_fulfillment',
    );
    const work = await sources.fulfillments(context, {
      before: new Date(
        +now() - configuration.thresholds.stuckSeconds * 1000,
      ).toISOString(),
      include: tracked.map((item) => ({
        fulfillmentId: item.subject.subjectId,
        connectionId: item.subject.scope[0]!,
      })),
      limit: limits.fulfillment,
    });
    for (const item of work) {
      const incident = tracked.find(
        (candidate) =>
          candidate.subject.subjectId === item.fulfillmentId &&
          candidate.subject.scope[0] === item.connectionId,
      );
      try {
        const { observation, complete } = await readFulfillment(context, item);
        if (!observation) continue;
        const request = fulfillmentRequest(
          context,
          fulfillmentInput(context, item, observation, complete),
          hash,
        );
        const result = await exceptions.ingest(context, request);
        if (result.decision.decision === 'detect')
          await diagnoseNew(context, result, incident);
        else if (result.decision.decision === 'clear' && incident)
          await verify(context, incident);
      } catch (error) {
        log(
          'A fulfillment check could not complete; it runs again next pass.',
          error,
        );
      }
    }
  }

  async function diagnoseNew(
    context: TenantContext,
    result: { incident: Incident | null },
    known: Incident | undefined,
  ) {
    if (!result.incident || known?.id === result.incident.id) return;
    await options
      .diagnose?.(context, result.incident.id)
      .catch((error: unknown) =>
        log('A new case could not be diagnosed yet.', error),
      );
  }

  async function verify(context: TenantContext, incident: Incident) {
    try {
      await exceptions.verify(context, incident.id);
    } catch (error) {
      log(
        'A case could not be verified; it is checked again next pass.',
        error,
      );
    }
  }

  const verifier: VerificationEvaluator & {
    handles(incident: Readonly<Incident>): boolean;
  } = {
    version: 'detection-monitor-v1',
    handles: (incident) =>
      ['sync_failure', 'inventory_mismatch', 'stuck_fulfillment'].includes(
        incident.exceptionClass,
      ),
    async evaluate(context, incident): Promise<VerificationResult> {
      if (incident.configVersion !== configuration.version)
        throw new Error('Verification configuration changed');
      if (incident.exceptionClass === 'inventory_mismatch') {
        const found = await stockMapping(context, incident);
        if (!found)
          throw new Error('Linked stock sources are no longer mapped');

        return inventoryMonitor(
          found.mapping,
          found.positionId,
        ).verifier.evaluate(context, incident);
      }
      if (incident.exceptionClass === 'stuck_fulfillment') {
        const [work] = await sources.fulfillments(context, {
          before: new Date(0).toISOString(),
          include: [
            {
              fulfillmentId: incident.subject.subjectId,
              connectionId: incident.subject.scope[0]!,
            },
          ],
          limit: 1,
        });
        if (!work) throw new Error('Fulfillment is no longer imported');
        const { observation, complete } = await readFulfillment(context, work);
        if (!observation)
          throw new Error('Fulfillment was not found in its source');
        const request = fulfillmentRequest(
          context,
          fulfillmentInput(context, work, observation, complete),
          hash,
        );

        return outcome(request.input, request.evidence, incident);
      }
      if (incident.exceptionClass === 'sync_failure') {
        const stream = (await sources.streams(context)).find(
          (item) =>
            item.connectionId === incident.subject.subjectId &&
            item.capability === incident.subject.scope[0],
        );
        if (!stream) throw new Error('Sync stream not found');
        const read = now().toISOString();
        const advanced =
          stream.active &&
          stream.attempts === 0 &&
          !!stream.lastCompleteAt &&
          Date.parse(stream.lastCompleteAt) >=
            Date.parse(incident.lastDetectedAt);
        const key = `sync-check:${stream.id}:${read}`;

        return {
          reason: advanced
            ? 'complete_scan_after_detection'
            : stream.attempts > 0
              ? 'reads_still_failing'
              : 'no_complete_scan_yet',
          outcome: advanced
            ? 'passed'
            : stream.attempts > 0
              ? 'failed'
              : 'inconclusive',
          complete: true,
          authoritative: true,
          evidence: [
            {
              ...syncEvent(context, stream),
              key,
              observedAt: read,
            },
          ],
          bindings: [
            {
              evidenceKey: key,
              exceptionClass: 'sync_failure',
              subject: incident.subject,
              postcondition: 'complete_scan_checkpoint_advanced',
            },
          ],
        };
      }
      throw new Error('This case type is not verified by detection');
    },
  };

  function outcome(
    input: Parameters<typeof evaluateException>[0],
    evidence: Evidence[],
    incident: Readonly<Incident>,
  ): VerificationResult {
    const decision = evaluateException(
      input,
      now().toISOString(),
      configuration.thresholds,
    );
    const sourced = evidence.filter((item) => item.connectionId !== null);

    return {
      reason: decision.reason,
      outcome:
        decision.decision === 'clear'
          ? 'passed'
          : decision.decision === 'detect'
            ? 'failed'
            : 'inconclusive',
      complete: true,
      authoritative: true,
      evidence: sourced,
      bindings: sourced.map((item) => ({
        evidenceKey: item.key,
        exceptionClass: 'stuck_fulfillment',
        subject: incident.subject,
        postcondition: 'fulfillment_disposition_verified',
      })),
    };
  }

  return {
    verifier,
    /**
     * Runs one detection and verification pass for a workspace. Each rule runs on its own, so
     * an unavailable source does not stop the others.
     */
    async tick(context: TenantContext) {
      requireRole(context, ['owner', 'admin']);
      const incidents = (await exceptions.list(context)).filter(open);
      for (const [name, run] of [
        ['Sync failure detection', syncFailures],
        ['Stock detection', stock],
        ['Fulfillment detection', fulfillments],
      ] as const)
        await run(context, incidents).catch((error: unknown) =>
          log(`${name} could not complete; retrying next pass.`, error),
        );
    },
  };
}

export type DetectionMonitor = ReturnType<typeof createDetectionMonitor>;
