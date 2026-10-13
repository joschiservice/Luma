import { z } from 'zod';

/** Bounds the canonical identities requested by incoming inventory views. */
export const incomingStockQuerySchema = z
  .object({
    skuIds: z.array(z.string().uuid()).min(1).max(250),
    locationId: z.string().uuid().optional(),
  })
  .strict();
