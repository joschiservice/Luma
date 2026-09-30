import type { CommerceObservation, SourceRecords } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import type { CommerceProjections } from '@luma/orders';

import { sourceLocalKey } from './source-local.js';

/**
 * Re-keys a remapped order's source children for its current mapping generation. Existing
 * parent bindings stay immutable; retries and later imports reuse the generation's IDs.
 */
export async function prepareOrderChildren(
  context: TenantContext,
  input: CommerceObservation,
  sources: SourceRecords,
  orders: CommerceProjections,
) {
  if (
    !['orders.read', 'fulfillment.read', 'returns.read'].includes(
      input.capability,
    )
  )
    return;
  const origin = input.observation.source;
  const parent =
    input.capability === 'orders.read'
      ? origin
      : input.capability === 'fulfillment.read' ||
          input.capability === 'returns.read'
        ? {
            ...origin,
            ...input.observation.data.order,
            resource: 'order' as const,
          }
        : null;
  if (!parent) return;
  const orderId = await sources.resolve(context, parent);
  if (!orderId) return;
  const mapping = (await sources.mappings(context, 'order', orderId)).find(
    (item) =>
      item.source.connectionId === parent.connectionId &&
      item.source.externalId === parent.externalId &&
      item.source.scopeKey === parent.scopeKey,
  );
  if (!mapping?.revisionId) return;
  const children =
    input.capability === 'orders.read'
      ? input.observation.data.lines.map((line) => ({
          ...origin,
          ...line.id,
          resource: 'order_line' as const,
        }))
      : input.capability === 'fulfillment.read' ||
          input.capability === 'returns.read'
        ? [
            origin,
            ...input.observation.data.lines.flatMap((line) =>
              line.orderLine
                ? [
                    {
                      ...origin,
                      ...line.orderLine,
                      resource: 'order_line' as const,
                    },
                  ]
                : [],
            ),
            ...(input.capability === 'returns.read' &&
            input.observation.data.type === 'refund' &&
            input.observation.data.return
              ? [
                  {
                    ...origin,
                    ...input.observation.data.return,
                    resource: 'return' as const,
                  },
                ]
              : []),
          ]
        : [];
  for (const child of children) {
    if (
      child.resource !== 'order_line' &&
      child.resource !== 'fulfillment' &&
      child.resource !== 'return' &&
      child.resource !== 'refund'
    )
      continue;
    const previous = await sources.resolve(context, child);
    if (!previous) continue;
    const boundParent = await orders.childParent(context, previous);
    if (
      boundParent &&
      boundParent !== orderId &&
      boundParent !== mapping.previousCanonicalId
    )
      throw new Error('Canonical child belongs to another order');
    const next = await orders.identify(
      context,
      child.resource,
      JSON.stringify([
        'order-link',
        orderId,
        mapping.revisionId,
        sourceLocalKey(child),
      ]),
    );
    if (previous !== next)
      await sources.remap(
        context,
        child,
        previous,
        next,
        'Re-keyed under an explicitly linked order',
        'Preserve source children under the order mapping generation',
      );
  }
}
