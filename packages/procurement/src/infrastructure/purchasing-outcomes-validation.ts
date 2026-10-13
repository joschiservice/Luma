import { z } from 'zod';

export const purchasingIgnoreSchema = z
  .object({
    id: z.string().uuid(),
    supplierId: z.string().uuid(),
    skuId: z.string().uuid(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
