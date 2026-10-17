import { z } from 'zod';

import { activityActorSchema } from './activity.js';

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
        actor: activityActorSchema.optional(),
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
        restricted: z
          .object({ permission: z.literal('inventory.read') })
          .optional()
          .describe(
            'Present when the entry is a stock booking step and the reader lacks the named permission. The entry then keeps only its kind, stage, time, source and evidence references; actor, reason, quantity, unit, revision and detail are null.',
          ),
      }),
    )
    .max(500),
  complete: z.boolean(),
});
