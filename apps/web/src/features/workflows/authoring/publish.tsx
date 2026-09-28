import type { DraftValidation, WorkflowDraft } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { type ReactNode, useState } from 'react';

import { IdentityError } from '../../identity/data';
import { workflowError } from '../data';
import { publishDraft } from './data';

/**
 * Publishes the exact saved revision after the author reviews problems and writes version notes.
 * Publishing creates an immutable version; activation happens separately.
 */
export function PublishDialog({
  organizationId,
  draft,
  validation,
  tests,
  close,
  published,
}: {
  organizationId: string;
  draft: WorkflowDraft;
  validation: DraftValidation | undefined;
  tests?: ReactNode | undefined;
  close(): void;
  published(result: Awaited<ReturnType<typeof publishDraft>>): void;
}) {
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const errors =
    validation?.diagnostics.filter((item) => item.severity === 'error') ?? [];
  const limits = [
    ...new Set(
      validation?.diagnostics
        .filter((item) => item.severity === 'warning')
        .map((item) => item.message) ?? [],
    ),
  ];
  // The editor passes validation only when it describes the saved content.
  const current = validation !== undefined;
  const blocked = !current || errors.length > 0 || !notes.trim();

  async function publish() {
    setPending(true);
    setError('');
    try {
      published(
        await publishDraft(organizationId, draft.id, {
          revision: draft.revision,
          notes: notes.trim(),
        }),
      );
    } catch (failure) {
      setError(workflowError(failure));
      setUncertain(
        !(failure instanceof IdentityError) || failure.status >= 500,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <DialogContent
        className="workflow-dialog authoring-publish"
        showCloseButton={!pending}
      >
        <DialogTitle>Publish version {draft.content.version}</DialogTitle>
        <DialogDescription>
          Publishing creates an unchangeable version. It doesn’t activate the
          workflow or give it access to anything. Activate it afterwards from
          the workflow page.
        </DialogDescription>
        {validation?.summary ? (
          <p className="authoring-summary">{validation.summary}</p>
        ) : null}
        {!current ? (
          <Alert tone="neutral" role="status">
            Checking the saved draft…
          </Alert>
        ) : null}
        {errors.length ? (
          <Alert tone="danger">
            <strong>Fix these before publishing:</strong>
            <ul>
              {errors.map((item) => (
                <li key={`${item.stepIndex}:${item.field}:${item.code}`}>
                  {item.stepId ? `${item.stepId}: ` : ''}
                  {item.message}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {limits.length ? (
          <Alert tone="warning">
            <strong>Can’t run in this workspace yet.</strong> You can publish
            it; it shows as unavailable until an installed adapter supports:
            <ul>
              {limits.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {tests}
        <label className="authoring-field">
          Version notes
          <Textarea
            rows={3}
            required
            maxLength={2000}
            disabled={pending || uncertain}
            value={notes}
            placeholder="What changed and why"
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        {error ? (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        ) : null}
        <div className="workflow-dialog-actions">
          <Button variant="outline" disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button disabled={blocked || pending} onClick={() => void publish()}>
            {pending
              ? 'Publishing…'
              : uncertain
                ? 'Retry publishing'
                : `Publish version ${draft.content.version}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
