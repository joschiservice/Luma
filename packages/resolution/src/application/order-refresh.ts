import type {
  CapabilityReader,
  ExternalId,
  FulfillmentSnapshot,
  Observation,
  OrderSnapshot,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';

/** One current source of a canonical order, as Luma last imported it. */
export interface OrderSource {
  connectionId: string;
  provider: string;
  /** The source's order ID. */
  order: ExternalId;
  /** The oldest stored read of the source's order and its fulfilment records, on Luma's clock. */
  observedAt: string;
  /** The connection may read fulfilment records. */
  fulfillments: boolean;
  /** The source's current fulfilment records of the order, as Luma stored their last reads. */
  stored: Observation<FulfillmentSnapshot>[];
}

/** Stored reads that name the sources of one order. */
export interface OrderSourceReader {
  /** Current, readable sources of the order; an unknown order has none. */
  orderSources(context: TenantContext, orderId: string): Promise<OrderSource[]>;
}

/** Fulfilment pages one reread may read; more fulfilment records leave the source unrefreshed. */
const maxFulfillmentPages = 5;

/**
 * Rereads every source of one order whose stored read is older than `maxAgeMs`: the order through
 * the `orders.read` point read and its fulfilment records through `fulfillment.read`, then stores
 * them as the source's current reads, so comparisons and change plans judge fresh evidence. A
 * source without a point read, or one whose read fails or is incomplete, keeps its stored reads;
 * freshness checks then fail honestly. Never writes to a source.
 */
export function createOrderRefresh(deps: {
  sources: OrderSourceReader;
  capabilities: Pick<CapabilityReader, 'read' | 'discover'>;
  /** Stores a fresh read; returns whether it became the source's current read. */
  project(
    context: TenantContext,
    read:
      | { capability: 'orders.read'; observation: Observation<OrderSnapshot> }
      | {
          capability: 'fulfillment.read';
          observation: Observation<FulfillmentSnapshot>;
        },
  ): Promise<boolean>;
  /** Creates an observation ID. */
  id(): string;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);

  async function readOrder(context: TenantContext, source: OrderSource) {
    const result = await deps.capabilities.read(context, {
      connectionId: source.connectionId,
      capability: 'orders.read',
      version: '0',
      input: { limit: 1, order: source.order },
    });
    if (!result.ok) throw new Error(`Order read failed: ${result.error.code}`);
    if (result.value.completeness !== 'complete' || result.value.nextCursor)
      throw new Error('Order read is incomplete');
    const found = result.value.items.filter(
      (item) =>
        item.kind === 'snapshot' &&
        item.source.connectionId === source.connectionId &&
        item.source.resource === 'order' &&
        item.source.externalId === source.order.externalId &&
        item.source.scopeKey === source.order.scopeKey,
    );
    if (found.length !== 1) throw new Error('The source no longer reports it');
    // Customer references and addresses are erasable personal data that sync keeps in the
    // customer store; stored order evidence never holds them.
    const observation = found[0] as Observation<OrderSnapshot>;
    const data = { ...observation.data };
    delete data.customer;
    delete data.addresses;

    return { ...observation, data };
  }

  async function readFulfillments(context: TenantContext, source: OrderSource) {
    const items: Observation<FulfillmentSnapshot>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxFulfillmentPages; page++) {
      const result = await deps.capabilities.read(context, {
        connectionId: source.connectionId,
        capability: 'fulfillment.read',
        version: '0',
        input: {
          limit: 100,
          order: source.order,
          ...(cursor ? { cursor } : {}),
        },
      });
      if (!result.ok)
        throw new Error(`Fulfillment read failed: ${result.error.code}`);
      if (result.value.completeness !== 'complete')
        throw new Error('Fulfillment read is incomplete');
      items.push(
        ...(result.value.items.filter(
          (item) =>
            item.source.connectionId === source.connectionId &&
            item.source.resource === 'fulfillment',
        ) as Observation<FulfillmentSnapshot>[]),
      );
      cursor = result.value.nextCursor ?? undefined;
      if (!cursor) return items;
    }
    throw new Error(
      'The order has more fulfilment records than one reread reads',
    );
  }

  /**
   * Work that a complete read of the order's fulfilment records no longer returns was removed at
   * the source, such as a delivery note the warehouse stopped packing. Shipped records never
   * disappear, so only unshipped ones are retired.
   */
  function retired(
    source: OrderSource,
    read: Observation<FulfillmentSnapshot>[],
    observedAt: string,
  ): Observation<FulfillmentSnapshot>[] {
    const key = (item: Observation<FulfillmentSnapshot>) =>
      JSON.stringify([item.source.externalId, item.source.scopeKey]);
    const present = new Set(read.map(key));

    return source.stored
      .filter(
        (item) =>
          !present.has(key(item)) &&
          !['shipped', 'delivered', 'completed'].includes(item.data.status),
      )
      .map((item) => ({
        ...item,
        id: deps.id(),
        kind: 'tombstone',
        observedAt,
        sourceUpdatedAt: null,
        sourceRevision: null,
      }));
  }

  /** Reads one source completely before storing anything, so a failed read changes nothing. */
  async function reread(context: TenantContext, source: OrderSource) {
    const descriptor = (
      await deps.capabilities.discover(context, source.connectionId)
    ).find((item) => item.capability === 'orders.read');
    if (!descriptor?.filters?.includes('order')) return false;
    const startedAt = now().toISOString();
    const order = await readOrder(context, source);
    const read = source.fulfillments
      ? await readFulfillments(context, source)
      : [];
    const fulfillments = [...read, ...retired(source, read, startedAt)];
    let current = await deps.project(context, {
      capability: 'orders.read',
      observation: order,
    });
    for (const observation of fulfillments)
      current =
        (await deps.project(context, {
          capability: 'fulfillment.read',
          observation,
        })) && current;

    return current;
  }

  return {
    /**
     * Rereads the order's stale sources. Returns how many sources became current and how many
     * could not be reread; the order's other sources keep their stored reads.
     */
    async refresh(context: TenantContext, orderId: string, maxAgeMs = 60_000) {
      let refreshed = 0;
      let failed = 0;
      for (const source of await deps.sources.orderSources(context, orderId)) {
        if (now().getTime() - Date.parse(source.observedAt) < maxAgeMs)
          continue;
        try {
          if (await reread(context, source)) refreshed++;
          else failed++;
        } catch (error) {
          failed++;
          log(
            'An order source could not be reread; its stored read stays.',
            error,
          );
        }
      }

      return { refreshed, failed };
    },
  };
}
