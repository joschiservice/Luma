import { z } from 'zod';

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

export const supplierContactInputSchema = z
  .object({
    id,
    expectedRevision: z.number().int().min(1),
    email: z.string().trim().toLowerCase().email().max(320).nullable(),
    language: z.enum(['en', 'de']).nullable(),
  })
  .strict();

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
