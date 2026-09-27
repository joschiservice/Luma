import { z } from 'zod';

const text = z.string().trim().min(1).max(200);

export const externalReferenceSchema = z
  .object({
    system: text,
    externalId: text,
    connectionId: z.string().uuid().optional(),
  })
  .strict();
const externalReferences = z.array(externalReferenceSchema).max(20).default([]);

export const supplierInputSchema = z
  .object({
    id: z.string().uuid(),
    name: text,
    externalReferences,
  })
  .strict();

export const supplierSchema = supplierInputSchema.extend({
  tenantId: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export const purchaseOrderStatusSchema = z.enum([
  'draft',
  'open',
  'closed',
  'cancelled',
]);

export const purchaseOrderInputSchema = z
  .object({
    id: z.string().uuid(),
    supplierId: z.string().uuid(),
    reference: text,
    authority: z.enum(['luma', 'external']).default('luma'),
    externalReferences,
    origin: z
      .object({
        workflowRunId: z.string().uuid().optional(),
        actionId: text.optional(),
        outcomeId: text.optional(),
      })
      .strict()
      .default({}),
    lines: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            sku: text,
            description: text,
            quantity: z.number().finite().positive().max(1_000_000_000),
            unit: z.string().trim().min(1).max(40),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export const transitionInputSchema = z
  .object({
    id: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    status: purchaseOrderStatusSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export const purchaseOrderSchema = purchaseOrderInputSchema.extend({
  tenantId: z.string().uuid(),
  supplierName: text,
  status: purchaseOrderStatusSchema,
  revision: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SupplierInput = z.input<typeof supplierInputSchema>;

export type Supplier = z.output<typeof supplierSchema>;

export type PurchaseOrderInput = z.input<typeof purchaseOrderInputSchema>;

export type PurchaseOrder = z.output<typeof purchaseOrderSchema>;

export type TransitionInput = z.output<typeof transitionInputSchema>;

export type PurchaseOrderStatus = PurchaseOrder['status'];

export const procurementEventSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime(),
  actorId: z.string(),
  from: purchaseOrderStatusSchema.nullable(),
  to: purchaseOrderStatusSchema,
  revision: z.number().int(),
  reason: z.string(),
});

export const purchaseOrderDetailSchema = z.object({
  order: purchaseOrderSchema,
  history: z.array(procurementEventSchema),
  allowedTransitions: z.array(purchaseOrderStatusSchema),
  canManage: z.boolean(),
});

export type PurchaseOrderDetail = z.infer<typeof purchaseOrderDetailSchema>;

export type PurchaseOrderLine = PurchaseOrder['lines'][number];
