import type { TenantContext } from '@luma/identity';
import { requirePermission } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { ExternalId } from '../domain/capabilities.js';

const checkSchema = z
  .object({
    observedAt: z.string().datetime({ offset: true }),
    complete: z.boolean(),
    observationIds: z.array(z.string().uuid()).max(2500),
  })
  .strict();
const orderSchema = z
  .object({
    externalId: z.string().min(1).max(1024),
    scopeKey: z.string().max(1024),
  })
  .strict();

/**
 * Stores a trusted refresh's lightweight completeness proof for one exact source order.
 * Requires the matching read permission; it never changes collection coverage or stores provider payloads.
 * Sources without active installed grants, including native records, receive no connector proof.
 */
export function createOrderReadChecks(database: TenantDatabase) {
  return async (
    context: TenantContext,
    connectionId: string,
    order: ExternalId,
    capability: 'orders.read' | 'fulfillment.read',
    check: { observedAt: string; complete: boolean; observationIds: string[] },
  ): Promise<void> => {
    requirePermission(
      context,
      capability === 'orders.read' ? 'orders.read' : 'fulfillment.read',
    );
    const source = orderSchema.parse(order);
    const proof = checkSchema.parse(check);
    await database.transaction(context.tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO connector_order_read_checks(tenant_id,connection_id,order_external_id,order_scope_key,capability,observed_at,complete,observation_ids)
         SELECT tenant_id,id,$3,$4,$5,$6,$7,$8::uuid[] FROM connector_installations
         WHERE tenant_id=$1 AND id=$2 AND document->>'status'='active' AND document->'permissions' ? $5 AND document->'granted' ? $5`,
        [
          context.tenantId,
          connectionId,
          source.externalId,
          source.scopeKey,
          capability,
          proof.observedAt,
          proof.complete,
          proof.observationIds,
        ],
      );
    });
  };
}
