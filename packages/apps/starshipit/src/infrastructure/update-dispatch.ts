import { ConnectorError } from '@luma/connections';
import { parse } from '@luma/connector-starshipit';
import * as s from '@luma/connector-starshipit/schemas';
import type { z } from 'zod';

import type { UpdateRun } from './update-store.js';

export interface UpdateDispatchPorts {
  /** Includes current tenant authorization, flags, authority and provider revision. */
  unchanged(run: UpdateRun): Promise<boolean>;
  read(
    run: UpdateRun,
  ): Promise<{ revision: string; order: z.infer<typeof s.order> }>;
  /** Durable fence; must mark sent before the request leaves. */
  send(id: string): Promise<boolean>;
  update(order: { order_id: number; items: unknown[] }): Promise<unknown>;
  /**
   * Stores the acceptance with the order and changed items the response named and returns its
   * ID. A failed store throws; the update then counts as sent with an unknown outcome.
   */
  accepted(
    id: string,
    records: { resource: 'order' | 'order_line'; externalId: string }[],
  ): Promise<string>;
}

/** Sends a reviewed update at most once. Lost responses and invalid acknowledgements require independent reconciliation. */
export async function dispatchUpdate(
  run: UpdateRun,
  idempotencyKey: string,
  ports: UpdateDispatchPorts,
) {
  if (!idempotencyKey || !(await ports.unchanged(run)))
    throw new ConnectorError({
      code: 'conflict',
      effect: 'none',
      retry: 'never',
    });
  const before = await ports.read(run);
  if (
    before.revision !== run.revision ||
    (before.order.status ?? before.order.order_status)?.toLowerCase() !==
      'unshipped' ||
    !before.order.items.every(
      (line) =>
        Number.isSafeInteger(Number(line.quantity)) &&
        Number(line.quantity) <= 999999,
    )
  )
    throw new ConnectorError({
      code: 'conflict',
      effect: 'none',
      retry: 'never',
    });
  if (!(await ports.unchanged(run)) || !(await ports.send(run.id)))
    throw new ConnectorError({
      code: 'conflict',
      effect: 'none',
      retry: 'never',
    });
  // The provider offers no atomic revision header. Retain each item's existing metadata and
  // rely on controlled targets plus one dispatch, never a preflight-based replay guarantee.
  const items = before.order.items.map((line) => {
    const fields = { ...line };
    delete fields.quantity_to_ship;
    delete fields.delete;

    return {
      ...fields,
      item_id: Number(line.item_id),
      quantity:
        run.lines.find((change) => change.lineItemId === line.item_id)
          ?.quantity ?? Number(line.quantity),
    };
  });
  let response: z.infer<typeof s.detail>;
  try {
    response = parse(
      s.detail,
      await ports.update({ order_id: Number(run.orderId), items }),
    );
  } catch (error) {
    if (error instanceof ConnectorError) {
      if (error.failure.code === 'invalid_response')
        throw new ConnectorError({
          ...error.failure,
          effect: 'unknown',
          retry: 'never',
        });
      throw error;
    }
    throw new ConnectorError({
      code: 'transient',
      effect: 'unknown',
      retry: 'never',
    });
  }
  if (response.order.order_id !== run.orderId)
    throw new ConnectorError({
      code: 'invalid_response',
      effect: 'unknown',
      retry: 'never',
    });
  const changed = new Set(run.lines.map((line) => line.lineItemId));
  let evidence: string;
  try {
    evidence = await ports.accepted(run.id, [
      { resource: 'order', externalId: response.order.order_id },
      ...response.order.items
        .filter((item) => changed.has(item.item_id))
        .map((item) => ({
          resource: 'order_line' as const,
          externalId: item.item_id,
        })),
    ]);
  } catch {
    // Starshipit accepted the update, but an unstored receipt must not be cited.
    throw new ConnectorError({
      code: 'internal',
      effect: 'unknown',
      retry: 'reconcile',
      dispatch: 'dispatched',
    });
  }

  return { evidenceRefs: [evidence], providerRequestId: null };
}
