import { type AskAssistant } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { queryOptions } from '@tanstack/react-query';

import { ApiError } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

/** Whether this workspace can ask Luma, the reason when it can't, and what it reads. */
export const assistantAvailabilityOptions = (organizationId: string) =>
  queryOptions({
    queryKey: ['private', 'organization', organizationId, 'assistant'],
    ...privateQueryDefaults,
    // Availability changes only when the server restarts with other model routes.
    staleTime: 5 * 60_000,
    gcTime: 5 * 60_000,
    queryFn: ({ signal }) =>
      api.assistant.availability({ params: { organizationId } }, { signal }),
  });

/** Asks one question. Reads only, so repeating a question after a failure is safe. */
export async function askAssistant(
  organizationId: string,
  body: AskAssistant,
  signal: AbortSignal,
) {
  return api.assistant.ask({ params: { organizationId }, body }, { signal });
}

/**
 * Localized feedback for a failed question. Other API errors show the server's message as
 * delivered, untranslated.
 */
export function assistantError(error: unknown) {
  if (error instanceof ApiError && error.status === 401)
    return m.assistant_error_session_expired();
  if (error instanceof ApiError && error.status === 403)
    return m.assistant_error_access_changed();
  if (error instanceof ApiError && error.code)
    return error.status === 400
      ? m.assistant_error_unreadable_question()
      : error.message;

  return m.assistant_error_unreachable();
}
