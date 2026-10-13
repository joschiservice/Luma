import { z } from 'zod';

import { outboundSchema } from './messaging.js';

const id = z.string().uuid();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00Z`);

    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  });

export const supplierEmailInputSchema = z
  .object({
    id,
    connectionId: id,
    requestedDeliveryDate: date,
    company: z
      .object({
        name: z.string().trim().min(1).max(200),
        address: z.string().trim().min(1).max(2000),
        registration: z.string().trim().max(500).nullable(),
      })
      .strict(),
  })
  .strict();

export const supplierFollowUpInputSchema = z
  .object({
    id,
    connectionId: id,
    threadId: id.optional(),
    attentionKey: z.string().min(1).max(500),
    nextCheckAt: z.string().datetime({ offset: true }),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const supplierEmailDraftSchema = outboundSchema.pick({
  id: true,
  threadId: true,
  connectionId: true,
  subject: true,
  text: true,
  state: true,
  stateReason: true,
  sentMessageId: true,
  attachments: true,
});

export const supplierEmailStatusSchema = z.object({
  canCompose: z.boolean(),
  submissionAvailable: z.boolean(),
  followUpAvailable: z.boolean(),
  mailboxes: z.array(
    z.object({
      connectionId: id,
      label: z.string(),
      address: z.string().nullable(),
    }),
  ),
  items: z.array(
    z.object({
      outbound: supplierEmailDraftSchema,
      work: z.object({
        purchaseOrderId: id,
        supplierId: id,
        kind: z.enum(['submission', 'follow_up']),
        requestedDeliveryDate: date.optional(),
        attentionKey: z.string().optional(),
        nextCheckAt: z.string().datetime({ offset: true }).optional(),
        reason: z.string().optional(),
      }),
    }),
  ),
});

export type SupplierEmailStatus = z.infer<typeof supplierEmailStatusSchema>;

export type SupplierEmailInput = z.infer<typeof supplierEmailInputSchema>;

export type SupplierFollowUpInput = z.infer<typeof supplierFollowUpInputSchema>;

export const supplierContactInputSchema = z
  .object({
    id,
    expectedRevision: z.number().int().min(1),
    email: z.string().trim().toLowerCase().email().max(320).nullable(),
    language: z.enum(['en', 'de']).nullable(),
  })
  .strict();

export type SupplierContactInput = z.infer<typeof supplierContactInputSchema>;
