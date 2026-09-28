import { z } from 'zod';

export const homeSearch = z.object({
  window: z.enum(['24h', '7d']).catch('24h').default('24h'),
});
