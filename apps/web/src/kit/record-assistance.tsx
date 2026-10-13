import type { AssistantContext } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';

import { createWebApiClient } from '../lib/api-client';
import { askLuma } from '../lib/assistant-panel';
import { privateQueryDefaults } from '../lib/private-query';
import { useCan } from './identity/permissions';

const api = createWebApiClient();

/** Opens Ask Luma beside the current record with its exact, server-reread navigation context. */
export function RecordAssistance({
  organizationId,
  context,
  label,
  onOpen,
}: {
  organizationId: string;
  context: AssistantContext;
  label: string;
  /** Releases a modal focus trap before revealing the docked assistant. */
  onOpen?: () => void;
}) {
  const permitted = useCan(organizationId, 'assistant.use');
  const availability = useQuery({
    queryKey: ['private', 'organization', organizationId, 'assistant'],
    ...privateQueryDefaults,
    enabled: permitted,
    staleTime: 5 * 60_000,
    gcTime: 5 * 60_000,
    queryFn: ({ signal }) =>
      api.assistant.availability({ params: { organizationId } }, { signal }),
  });
  if (!permitted || !availability.data?.contextual) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        onOpen?.();
        askLuma(m.assistant_context_question(), { context, label });
      }}
    >
      <Sparkles aria-hidden="true" />
      {m.assistant_context_explain()}
    </Button>
  );
}
