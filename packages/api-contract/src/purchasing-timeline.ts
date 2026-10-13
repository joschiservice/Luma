import { z } from 'zod';

/** Purchasing facts and action history preserve separate recording, observation and verification states. */
export const purchasingTimelineSchema = z.object({
  entries: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum([
          'draft',
          'lifecycle',
          'submission',
          'supplier_message',
          'commitment',
          'follow_up',
          'revision',
          'stock_booking',
        ]),
        stage: z.enum([
          'recorded',
          'approval_required',
          'approved',
          'rejected',
          'sending',
          'sent',
          'observed',
          'uncertain',
          'failed',
          'verified',
        ]),
        at: z.string().datetime(),
        actorId: z.string().nullable(),
        reason: z.string().nullable(),
        evidenceRefs: z.array(z.string()),
        quantity: z.number().nullable(),
        unit: z.string().nullable(),
        revision: z.number().int().positive().nullable(),
        detail: z.string().nullable(),
        source: z.enum([
          'luma',
          'manual',
          'purchasing_system',
          'email',
          'inventory',
        ]),
      }),
    )
    .max(500),
  complete: z.boolean(),
});
