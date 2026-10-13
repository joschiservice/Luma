import type { SourceRecords } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import type { CommerceProjections } from '@luma/orders';

import { LinkError } from './errors.js';

/** Only current lines on the same explicitly linked order and in the same units can be equivalent. */
export async function validateOrderLineIdentity(
  orders: Pick<CommerceProjections, 'childParent' | 'current'>,
  context: TenantContext,
  targetId: string,
  otherId: string,
  target: Awaited<ReturnType<SourceRecords['mappings']>>,
  other: Awaited<ReturnType<SourceRecords['mappings']>>,
) {
  const parent = await orders.childParent(context, targetId);
  if (!parent || (await orders.childParent(context, otherId)) !== parent)
    throw new LinkError('Link the parent orders before matching their lines');
  const projections = await orders.current(context, parent);
  const units = new Set<string>();
  for (const [id, mappings] of [
    [targetId, target],
    [otherId, other],
  ] as const) {
    for (const mapping of mappings) {
      const projection = projections.find(
        (item) => item.snapshot.connectionId === mapping.source.connectionId,
      );
      const data = projection?.snapshot.data;
      const matches =
        data?.type === 'order' && !projection?.snapshot.deleted
          ? data.lines.filter((line) => line.id === id)
          : [];
      if (matches.length !== 1)
        throw new LinkError('Only current order lines can be matched');
      units.add(matches[0]!.unit);
    }
  }
  if (!other.length || units.size !== 1)
    throw new LinkError('The order lines must use the same units');

  return parent;
}
