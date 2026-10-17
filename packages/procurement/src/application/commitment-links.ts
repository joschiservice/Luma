import type { TenantContext } from '@luma/identity';
import { conflict, notFound, unavailable } from '@luma/platform';

import type { Supplier } from '../domain/procurement.js';
import type { CommitmentContext } from './commitment-context.js';

/**
 * Purchasing-system connections and supplier links: which connections can act as purchasing
 * systems, their supplier records, and the link and confirmation terms of a Luma supplier.
 */
export function createSupplierLinks({
  deps,
  authorize,
  audit,
}: CommitmentContext) {
  return {
    /** Lists connections usable as purchasing systems. */
    async connections(context: TenantContext) {
      context = await authorize(context);

      return deps.purchasing ? deps.purchasing.connections(context) : [];
    },
    /** Lists suppliers in a purchasing system for linking. */
    async purchasingSuppliers(
      context: TenantContext,
      connectionId: string,
      cursor?: string,
    ) {
      context = await authorize(context, true);
      if (!deps.purchasing)
        throw unavailable('Purchasing-system connections are unavailable.');
      const result = await deps.purchasing.suppliers(context, connectionId, {
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) throw unavailable(result.reason);

      return result.ok ? result.value : { items: [], nextCursor: null };
    },
    /** Links a supplier to its purchasing-system record and sets follow-up terms. */
    async linkSupplier(
      context: TenantContext,
      supplierId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      const request = deps.parse.link(input);
      let name: string | null = null;
      if (request.link) {
        if (!deps.purchasing)
          throw unavailable('Purchasing-system connections are unavailable.');
        const result = await deps.purchasing.suppliers(
          context,
          request.link.connectionId,
          {
            supplier: {
              externalId: request.link.externalId,
              scopeKey: request.link.scopeKey,
            },
          },
        );
        if (!result.ok) throw unavailable(result.reason);
        const found = result.ok
          ? result.value.items.find(
              (s) => s.externalId === request.link!.externalId,
            )
          : undefined;
        if (!found)
          throw conflict(
            'That supplier was not found in the purchasing system.',
          );
        name = found.name;
      }

      return deps.store.transaction(context.tenantId, true, async (tx) => {
        const supplier = await tx.supplier(supplierId);
        if (!supplier) throw notFound('Supplier not found');
        const revision = supplier.revision ?? 1;
        if (revision !== request.expectedRevision)
          throw conflict('This supplier changed. Refresh and review it again.');
        const now = deps.now().toISOString();
        const next: Supplier = {
          ...supplier,
          revision: revision + 1,
          confirmationHours: request.confirmationHours,
          link: request.link
            ? {
                ...request.link,
                name,
                linkedBy: context.actor.id,
                linkedAt: now,
              }
            : null,
        };
        await tx.updateSupplier(next);
        await tx.audit({
          ...audit(
            context,
            'supplier.updated',
            `${supplierId}:${next.revision}`,
            supplierId,
            {
              supplierId,
              revision: String(next.revision),
              connectionId: request.link?.connectionId ?? '',
              externalId: request.link?.externalId ?? '',
              confirmationHours: String(request.confirmationHours),
            },
          ),
          correlationId: supplierId,
          proposalId: supplierId,
        });

        return next;
      });
    },
  };
}
