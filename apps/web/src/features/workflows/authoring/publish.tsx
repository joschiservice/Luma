import type { DraftValidation, WorkflowDraft } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
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

import { ApiError } from '../../../kit/identity/data';
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
      setUncertain(!(failure instanceof ApiError) || failure.status >= 500);
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
        <DialogTitle>
          {m.authoring_publish_title({ version: draft.content.version })}
        </DialogTitle>
        <DialogDescription>
          {m.authoring_publish_description()}
        </DialogDescription>
        {validation?.summary ? (
          <p className="authoring-summary">{validation.summary}</p>
        ) : null}
        {!current ? (
          <Alert tone="neutral" role="status">
            {m.authoring_publish_checking()}
          </Alert>
        ) : null}
        {errors.length ? (
          <Alert tone="danger">
            <strong>{m.authoring_publish_fix_first()}</strong>
            <ul>
              {errors.map((item) => (
                <li key={`${item.stepIndex}:${item.field}:${item.code}`}>
                  {item.stepId
                    ? m.authoring_publish_step_problem({
                        step: item.stepId,
                        problem: item.message,
                      })
                    : item.message}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {limits.length ? (
          <Alert tone="warning">
            <strong>{m.authoring_publish_limits_title()}</strong>{' '}
            {m.authoring_publish_limits_body()}
            <ul>
              {limits.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {tests}
        <label className="authoring-field">
          {m.authoring_publish_notes_label()}
          <Textarea
            rows={3}
            required
            maxLength={2000}
            disabled={pending || uncertain}
            value={notes}
            placeholder={m.authoring_publish_notes_placeholder()}
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
            {m.common_cancel()}
          </Button>
          <Button disabled={blocked || pending} onClick={() => void publish()}>
            {pending
              ? m.authoring_publish_pending()
              : uncertain
                ? m.authoring_publish_retry()
                : m.authoring_publish_button({
                    version: draft.content.version,
                  })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
