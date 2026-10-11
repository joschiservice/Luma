import type { WorkflowDetail } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { FilePenLine } from 'lucide-react';
import { useState } from 'react';

import { IdentityError } from '../../../kit/identity/data';
import { workflowError } from '../data';
import { createDraft, draftsKey } from './data';

/**
 * Starts a new draft from the selected published version. The published version and its
 * activations stay exactly as they are; publishing the draft creates a new version.
 */
export function EditWorkflowButton({
  organizationId,
  detail,
  version,
}: {
  organizationId: string;
  detail: WorkflowDetail;
  version: string;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [request, setRequest] = useState<
    Parameters<typeof createDraft>[1] | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function edit() {
    const body = request ?? {
      id: crypto.randomUUID(),
      mode: 'visual' as const,
      start: {
        kind: 'version' as const,
        definitionId: detail.summary.id,
        version,
      },
    };
    setRequest(body);
    setPending(true);
    setError('');
    try {
      const draft = await createDraft(organizationId, body);
      await client.invalidateQueries({ queryKey: draftsKey(organizationId) });
      await navigate({
        to: '/app/$organizationId/workflows/drafts/$draftId',
        params: { organizationId, draftId: draft.id },
        search: { view: 'build' },
      });
    } catch (failure) {
      setError(workflowError(failure));
      if (failure instanceof IdentityError && failure.status < 500)
        setRequest(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="outline" disabled={pending} onClick={() => void edit()}>
        <FilePenLine aria-hidden="true" />
        {pending
          ? m.authoring_edit_opening()
          : request && error
            ? m.common_try_again()
            : m.authoring_edit_button()}
      </Button>
      {error ? (
        <span role="alert" className="authoring-inline-error">
          {error}
        </span>
      ) : null}
    </>
  );
}
