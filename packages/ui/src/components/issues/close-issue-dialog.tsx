import type { CaseProgress } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { useId, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '../primitives/alert';
import { Button } from '../primitives/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../primitives/dialog';
import { Field, FieldDescription, FieldLabel } from '../primitives/field';
import { Textarea } from '../primitives/textarea';

/** Collects a manual closure reason and confirms that closing cannot cancel an in-flight change. */
export function CloseIssueDialog({
  progress,
  disabled,
  onClose,
}: {
  progress?: CaseProgress | undefined;
  disabled: boolean;
  onClose(reason: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const id = useId();
  const phase = progress?.workflow.progress?.phase;
  const inProgress =
    !progress ||
    progress.workflow.availability === 'unavailable' ||
    ['prepared', 'unknown'].includes(progress.execution?.state ?? '') ||
    ['executing', 'verifying'].includes(progress.state) ||
    [
      'detecting',
      'diagnosing',
      'proposing',
      'executing',
      'awaiting_approval',
      'reconciling',
      'verifying',
    ].includes(phase ?? '');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setAcknowledged(false);
      }}
    >
      <DialogTrigger render={<Button variant="outline" disabled={disabled} />}>
        {m.issues_close_action()}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.issues_close_action()}</DialogTitle>
          <DialogDescription>{m.issues_close_description()}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled || !reason.trim() || (inProgress && !acknowledged))
              return;
            onClose(reason.trim());
            setOpen(false);
          }}
        >
          <Field>
            <FieldLabel htmlFor={id}>{m.issues_close_reason()}</FieldLabel>
            <Textarea
              id={id}
              required
              maxLength={1000}
              value={reason}
              disabled={disabled}
              onChange={(event) => setReason(event.target.value)}
              aria-describedby={`${id}-help`}
            />
            <FieldDescription id={`${id}-help`}>
              {m.issues_close_help()}
            </FieldDescription>
          </Field>
          {inProgress ? (
            <Alert tone="warning">
              <AlertTitle>{m.issues_close_running_title()}</AlertTitle>
              <AlertDescription>
                {m.issues_close_running_body()}
              </AlertDescription>
              <FieldLabel>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={disabled}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />{' '}
                {m.issues_close_running_confirm()}
              </FieldLabel>
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {m.common_cancel()}
            </DialogClose>
            <Button
              type="submit"
              disabled={
                disabled || !reason.trim() || (inProgress && !acknowledged)
              }
            >
              {m.issues_close_action()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
