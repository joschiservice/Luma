import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import { z } from 'zod';

import type { ProcurementService } from '../application/procurement.js';
import {
  purchaseOrderInputSchema,
  purchaseOrderOutputSchema,
  supplierOutputSchema,
  transitionInputSchema,
} from './validation.js';

const supplierLookupSchema = z
  .object({ supplierId: z.string().uuid() })
  .strict();
const openOrdersSchema = z
  .object({ supplierId: z.string().uuid().optional() })
  .strict();
const transitionSchema = transitionInputSchema.extend({
  purchaseOrderId: z.string().uuid(),
});

/** Binds typed procurement operations to the tenant-owned record service. */
export function createProcurementCapabilities(service: ProcurementService) {
  return {
    /** Returns a supplier in the current workspace, or null. */
    async lookupSupplier(context: TenantContext, input: unknown) {
      const { supplierId } = supplierLookupSchema.parse(input);
      const supplier = await service.supplier(context, supplierId);

      return supplier === null ? null : supplierOutputSchema.parse(supplier);
    },
    /** Returns currently open purchase orders, optionally scoped to a supplier. */
    async lookupOpenOrders(context: TenantContext, input: unknown) {
      const { supplierId } = openOrdersSchema.parse(input);

      return z
        .array(purchaseOrderOutputSchema)
        .parse(await service.openOrders(context, supplierId));
    },
    /** Creates a Luma-owned draft; its ID is the durable retry key. */
    async createOrder(context: TenantContext, input: unknown) {
      const request = purchaseOrderInputSchema.parse(input);
      if (request.authority !== 'luma')
        throw new Error('The capability creates Luma-owned orders only.');

      return purchaseOrderOutputSchema.parse(
        await service.createOrder(context, request, {
          preventDuplicateSku: !!request.origin.workflowRunId,
        }),
      );
    },
    /** Applies a revision-checked lifecycle change with an audited command ID. */
    async transitionOrder(context: TenantContext, input: unknown) {
      const { purchaseOrderId, ...request } = transitionSchema.parse(input);

      return purchaseOrderOutputSchema.parse(
        await service.transition(context, purchaseOrderId, request),
      );
    },
    /** Reads the committed order after execution to verify tenant, state and revision. */
    async verifyOrder(
      context: TenantContext,
      id: string,
      expected: {
        status: 'draft' | 'open' | 'closed' | 'cancelled';
        revision?: number;
        commandId?: string;
      },
    ) {
      requireTenant(context, context.tenantId);
      const detail = await service.detail(context, z.string().uuid().parse(id));
      const order = purchaseOrderOutputSchema.parse(detail.order);
      const history = z
        .array(
          z.object({
            id: z.string().uuid(),
            commandId: z.string().uuid().optional(),
          }),
        )
        .parse(detail.history);

      return {
        passed:
          order.tenantId === context.tenantId &&
          order.authority === 'luma' &&
          order.status === expected.status &&
          (expected.revision === undefined ||
            order.revision === expected.revision) &&
          (expected.commandId === undefined ||
            history.some((event) => event.commandId === expected.commandId)),
        order,
        evidenceRefs: history
          .filter(
            (event) =>
              expected.commandId === undefined ||
              event.commandId === expected.commandId,
          )
          .map((event) => event.id),
      };
    },
  };
}
