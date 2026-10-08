import { m } from '@luma/i18n/messages';
import { z } from 'zod';

// Illustrative contract for the workshop, not a production contact API. Messages are functions,
// so each validation reports them in the active interface language.
export const contactSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, { error: () => m.ui_example_contact_name_too_short() })
    .max(80, { error: () => m.ui_example_contact_name_too_long() }),
  email: z
    .string()
    .trim()
    .max(254, { error: () => m.ui_example_contact_email_too_long() })
    .pipe(z.email({ error: () => m.ui_example_contact_email_invalid() })),
});

export type ContactInput = z.input<typeof contactSchema>;

export type Contact = z.output<typeof contactSchema>;

export const saveContactResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved') }),
  z.object({ kind: z.literal('email-conflict') }),
]);
