import type {
  CapabilityReader,
  InventorySnapshot,
  Observation,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';

import type { DetectionSources, PositionSource } from './detection-monitor.js';

/**
 * Rereads a stock position's sources whose stored report is older than `maxAgeMs`, through the
 * installed capabilities, and stores each fresh read as the source's current report. Owners call
 * it right before they act, so a decision can wait for a person while the action still uses
 * current stock. A source that can't be read keeps its stored report; freshness checks then fail
 * honestly.
 */
export function createStockRefresh(deps: {
  sources: Pick<DetectionSources, 'positionSources'>;
  capabilities: Pick<CapabilityReader, 'read'>;
  /** Stores a fresh read; returns whether it became the source's current report. */
  project(
    context: TenantContext,
    observation: Observation<InventorySnapshot>,
    positionId: string,
  ): Promise<boolean>;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);

  async function read(
    context: TenantContext,
    source: PositionSource,
    readPurpose?: 'foreground' | 'incremental' | 'history',
  ) {
    let cursor: string | undefined;
    do {
      const result = await deps.capabilities.read(context, {
        connectionId: source.connectionId,
        capability: 'inventory.read',
        version: '0',
        ...(readPurpose ? { readPurpose } : {}),
        input: {
          limit: 100,
          sku: source.sku,
          location: source.location,
          ...(cursor ? { cursor } : {}),
        },
      });
      if (!result.ok)
        throw new Error(`Inventory read failed: ${result.error.code}`);
      if (result.value.completeness !== 'complete')
        throw new Error('Inventory read is incomplete');
      const found = result.value.items.find(
        (item) =>
          item.source.connectionId === source.connectionId &&
          item.source.resource === 'sku' &&
          item.source.externalId === source.sku.externalId &&
          item.source.scopeKey === source.location.externalId,
      );
      if (found) return found as Observation<InventorySnapshot>;
      cursor = result.value.nextCursor ?? undefined;
    } while (cursor);

    return null;
  }

  return {
    /** Returns how many sources were reread and became current. */
    async refresh(
      context: TenantContext,
      positionId: string,
      maxAgeMs = 60_000,
      options?: {
        connectionId?: string;
        readPurpose?: 'foreground' | 'incremental' | 'history';
      },
    ) {
      let current = 0;
      for (const source of await deps.sources.positionSources(
        context,
        positionId,
      )) {
        if (
          options?.connectionId &&
          source.connectionId !== options.connectionId
        )
          continue;
        if (now().getTime() - Date.parse(source.observedAt) < maxAgeMs)
          continue;
        try {
          const observation = await read(context, source, options?.readPurpose);
          if (
            observation &&
            (await deps.project(context, observation, positionId))
          )
            current++;
        } catch (error) {
          log(
            'A stock source could not be reread; its stored report stays.',
            error,
          );
        }
      }

      return current;
    },
  };
}
