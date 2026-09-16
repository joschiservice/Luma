import { z } from 'zod';

// Illustrative contract for the workshop, not a production contact API.
export const contactSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Use at least 2 characters.')
    .max(80, 'Use 80 characters or fewer.'),
  email: z
    .string()
    .trim()
    .max(254, 'Use 254 characters or fewer.')
    .pipe(z.email({ error: 'Enter a valid email address.' })),
});

export type ContactInput = z.input<typeof contactSchema>;
export type Contact = z.output<typeof contactSchema>;

export const saveContactResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved') }),
  z.object({ kind: z.literal('email-conflict') }),
]);
