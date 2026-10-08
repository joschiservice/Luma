import {
  type AskAssistant,
  assistantAnswerSchema,
  assistantAvailabilitySchema,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

/** Whether this workspace can ask Luma, the reason when it can't, and what it reads. */
export const assistantAvailabilityOptions = (organizationId: string) =>
  queryOptions({
    queryKey: ['private', 'organization', organizationId, 'assistant'],
    ...privateQueryDefaults,
    // Availability changes only when the server restarts with other model routes.
    staleTime: 5 * 60_000,
    gcTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const result = await api.assistant.availability({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200)
        throw new IdentityError(result.status, result.body);

      return assistantAvailabilitySchema.parse(result.body);
    },
  });

/** Asks one question. Reads only, so repeating a question after a failure is safe. */
export async function askAssistant(
  organizationId: string,
  body: AskAssistant,
  signal: AbortSignal,
) {
  const result = await api.assistant.ask({
    params: { organizationId },
    body,
    fetchOptions: { signal },
  });
  if (result.status !== 200)
    throw new IdentityError(result.status, result.body);

  return assistantAnswerSchema.parse(result.body);
}

/**
 * Localized feedback for a failed question. Other API errors show the server's message as
 * delivered, untranslated.
 */
export function assistantError(error: unknown) {
  if (error instanceof IdentityError && error.status === 401)
    return m.assistant_error_session_expired();
  if (error instanceof IdentityError && error.status === 403)
    return m.assistant_error_access_changed();
  if (error instanceof IdentityError && error.code)
    return error.status === 400
      ? m.assistant_error_unreadable_question()
      : error.message;

  return m.assistant_error_unreachable();
}
