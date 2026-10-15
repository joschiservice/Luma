import type {
  CapabilityReader,
  InventorySnapshot,
  Observation,
} from '@luma/connections';
import type {
  Configuration,
  DetectionService,
  Incident,
  VerificationEvaluator,
} from '@luma/exceptions';
import { evaluateException } from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';

import type { InventoryMapping, StockAgreement } from './detection.js';
import { inventoryRequest } from './detection.js';

export interface InventoryMonitorOptions {
  capabilities: Pick<CapabilityReader, 'read'>;
  mapping: InventoryMapping;
  configuration: Configuration;
  /** Produces stable keys for mapping and observation evidence. */
  hash(value: string): string;
  /** Persists the observation and confirms its canonical projection is current. */
  project(
    context: TenantContext,
    observation: Observation<InventorySnapshot>,
  ): Promise<boolean>;
  /**
   * Finds when both sides last agreed and when Luma first saw them disagree afterwards, so a
   * new gap can wait for provider sync. Without it, every gap is evaluated at once.
   */
  agreement?(
    context: TenantContext,
    window: { since: string; until: string },
  ): Promise<Pick<
    StockAgreement,
    'agreedAt' | 'mismatchSince' | 'snapshotIds'
  > | null>;
  /** The open stock sync stall case that covers this pair; its gaps wait unless they oversell. */
  stall?: { exceptionId: string; detectedAt: string };
  now?: () => Date;
}

// Luma reads agreeing positions only during sync, so the last agreement can be hours old when
// a sale opens a gap. A gap with no agreement in a day is old and is not waited on.
const agreementLookbackSeconds = 86_400;

/** Reads a mapped stock pool completely and verifies recovery with independent provider evidence. */
export function createInventoryMonitor(options: InventoryMonitorOptions) {
  const { mapping, configuration, capabilities, project, hash } = options;
  const now = options.now ?? (() => new Date());

  async function readSide(
    context: TenantContext,
    side: InventoryMapping['left'],
  ) {
    requireTenant(context, mapping.tenantId);
    requireTenant(context, side.source.tenantId);
    const cursors = new Set<string>();
    const matches: Observation<InventorySnapshot>[] = [];
    let cursor: string | undefined;
    do {
      const result = await capabilities.read(context, {
        connectionId: side.source.connectionId,
        capability: 'inventory.read',
        version: '0',
        input: {
          limit: 100,
          sku: side.sku,
          location: side.location,
          ...(cursor ? { cursor } : {}),
        },
      });
      if (!result.ok)
        throw new Error(`Inventory read failed: ${result.error.code}`);
      if (result.value.completeness !== 'complete')
        throw new Error('Inventory read is incomplete');
      for (const observation of result.value.items) {
        const source = observation.source;
        if (
          source.tenantId === side.source.tenantId &&
          source.connectionId === side.source.connectionId &&
          source.provider === side.source.provider &&
          source.resource === side.source.resource &&
          source.externalId === side.source.externalId &&
          source.scopeKey === side.source.scopeKey
        )
          matches.push(observation);
      }
      cursor = result.value.nextCursor ?? undefined;
      if (cursor) {
        if (cursors.has(cursor) || cursors.size >= 100)
          throw new Error('Inventory pagination did not complete');
        cursors.add(cursor);
      }
    } while (cursor);
    if (matches.length !== 1)
      throw new Error('Mapped inventory record is missing or ambiguous');

    return matches[0]!;
  }

  async function agreement(
    context: TenantContext,
  ): Promise<StockAgreement | undefined> {
    if (!options.agreement) return undefined;
    const until = now();
    const window = {
      since: new Date(+until - agreementLookbackSeconds * 1000).toISOString(),
      until: until.toISOString(),
    };
    const found = await options.agreement(context, window);

    return {
      ...window,
      agreedAt: found?.agreedAt ?? null,
      mismatchSince: found?.mismatchSince ?? null,
      snapshotIds: found?.snapshotIds ?? [],
    };
  }

  async function read(context: TenantContext) {
    // History is read before the fresh pair is recorded, so it describes the time before it.
    const agreed = await agreement(context);
    const left = await readSide(context, mapping.left);
    const right = await readSide(context, mapping.right);
    const leftCurrent = await project(context, left);
    const rightCurrent = await project(context, right);

    return inventoryRequest(
      context,
      {
        left,
        right,
        mapping,
        configuration,
        complete: true,
        projectionCurrent: leftCurrent && rightCurrent,
        ...(agreed ? { agreement: agreed } : {}),
        ...(options.stall ? { stall: options.stall } : {}),
      },
      hash,
    );
  }

  function matches(incident: Incident) {
    return (
      incident.tenantId === mapping.tenantId &&
      incident.exceptionClass === 'inventory_mismatch' &&
      incident.subject.ruleIdentity === 'available-stock' &&
      incident.subject.subjectKind === 'sku' &&
      incident.subject.subjectId === mapping.skuId &&
      JSON.stringify(incident.subject.scope) ===
        JSON.stringify([
          mapping.locationId,
          ...[
            mapping.left.source.connectionId,
            mapping.right.source.connectionId,
          ].sort(),
        ])
    );
  }

  const verifier: VerificationEvaluator = {
    version: 'inventory-agreement-v1',
    async evaluate(context, incident) {
      if (
        !matches(incident) ||
        incident.configVersion !== configuration.version
      )
        throw new Error(
          'Inventory verification scope or configuration changed',
        );
      const request = await read(context);
      const decision = evaluateException(
        request.input,
        now().toISOString(),
        configuration.thresholds,
      );
      const evidence = request.evidence.filter(
        (item) => item.connectionId !== null,
      );

      return {
        reason: decision.reason,
        outcome:
          decision.decision === 'clear'
            ? 'passed'
            : decision.decision === 'detect'
              ? 'failed'
              : 'inconclusive',
        complete: true,
        authoritative: mapping.authority !== null,
        evidence,
        bindings: evidence.map((item) => ({
          evidenceKey: item.key,
          exceptionClass: 'inventory_mismatch',
          subject: incident.subject,
          postcondition: 'equivalent_inventory_agrees',
        })),
      };
    },
  };

  return {
    matches,
    verifier,
    /** Reads both sides fresh and records them; returns the evaluation request without ingesting it. */
    read,
    /** Runs detection on fresh observations; a clear result still requires independent verification. */
    async check(
      context: TenantContext,
      exceptions: Pick<DetectionService, 'ingest'>,
    ) {
      return exceptions.ingest(context, await read(context));
    },
  };
}
