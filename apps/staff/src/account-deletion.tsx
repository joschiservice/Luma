import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import {
  Field,
  FieldError,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { reasonSchema } from './access';
import { useRegionalStaffApi } from './api';
import { Failure } from './feedback';
import { staffRegion } from './regions';

/** Why an account is deleted; kept with the erasure receipt. */
export const deletionCategories = [
  { value: 'customer_request', label: 'Customer request' },
  { value: 'gdpr_erasure', label: 'GDPR erasure request' },
  { value: 'abuse', label: 'Abuse' },
  { value: 'inactivity', label: 'Inactivity' },
] as const;

/** Names a stored deletion category. */
export function deletionCategoryLabel(value: string) {
  return (
    deletionCategories.find((category) => category.value === value)?.label ??
    value
  );
}

const copy = {
  schedule: {
    title: 'Schedule account deletion',
    description: (email: string) =>
      `Sign ${email} out everywhere, refuse new sign-ins and suspend their memberships now. The account and its personal data are erased after 30 days unless you restore it. They are notified by email.`,
    reason: 'Reason for deleting the account',
    acknowledge:
      'I understand that this locks the person out of all their workspaces now and erases the account after 30 days.',
    submit: 'Schedule deletion',
    pending: 'Scheduling…',
  },
  restore: {
    title: 'Restore account',
    description: (email: string) =>
      `Cancel the deletion of ${email}. The memberships it suspended become active again with their roles, and the account can sign in again unless it was disabled before. They are notified by email.`,
    reason: 'Reason for restoring the account',
    acknowledge: '',
    submit: 'Restore account',
    pending: 'Restoring…',
  },
  erase_now: {
    title: 'Erase account now',
    description: (email: string) =>
      `Only for a verified erasure request (GDPR Art. 17). ${email} is erased within minutes, without the 30-day restore window. Workspaces keep their history, showing a former member.`,
    reason: 'How the request was verified',
    acknowledge:
      'I understand that erasure is permanent and the account can’t be restored.',
    submit: 'Erase account now',
    pending: 'Requesting erasure…',
  },
} as const;

/**
 * Schedules a deletion, restores an account within its window, or erases it now for a verified
 * erasure request. Scheduling and erasing need a request reference and an acknowledgement. Keeps
 * one command ID for safe retries.
 */
export function AccountDeletionDialog({
  userId,
  grantId,
  email,
  action,
  onClose,
}: {
  userId: string;
  grantId: string;
  email: string;
  action: 'schedule' | 'restore' | 'erase_now';
  onClose: () => void;
}) {
  const staffApi = useRegionalStaffApi();
  const client = useQueryClient();
  const ids = useId();
  const text = copy[action];
  const needsReference = action !== 'restore';
  const [commandId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [errors, setErrors] = useState<{
    reason?: string | undefined;
    reference?: string | undefined;
  }>({});
  const [category, setCategory] =
    useState<(typeof deletionCategories)[number]['value']>('customer_request');
  const [acknowledged, setAcknowledged] = useState(false);
  const change = useMutation({
    mutationFn: (value: { reason: string; reference: string }) =>
      staffApi.changeAccountDeletion(
        userId,
        action === 'schedule'
          ? { action, grantId, commandId, category, ...value }
          : action === 'erase_now'
            ? { action, grantId, commandId, ...value }
            : { action, grantId, commandId, reason: value.reason },
      ),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ['staff', staffRegion(), 'account', userId],
      }),
  });
  // A failed request keeps its inputs: a retry with the same command ID returns the original result.
  const locked = change.isPending || change.isError;

  function submit() {
    const parsed = reasonSchema.safeParse(reason);
    const trimmed = reference.trim();
    const referenceError =
      needsReference && (trimmed.length < 3 || trimmed.length > 200)
        ? 'Enter the request reference, such as a ticket ID, without personal data.'
        : undefined;
    setErrors({
      reason: parsed.success ? undefined : parsed.error.issues[0]!.message,
      reference: referenceError,
    });
    if (!parsed.success || referenceError || (needsReference && !acknowledged))
      return;
    change.mutate({ reason: parsed.data, reference: trimmed });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !change.isPending) onClose();
      }}
    >
      <DialogContent showCloseButton={!change.isPending}>
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description(email)}</DialogDescription>
        </DialogHeader>
        {change.isSuccess ? (
          <>
            <Alert tone="success" role="status">
              <AlertDescription>
                {change.data.status === 'scheduled'
                  ? `Deletion scheduled. The account is erased after ${new Date(change.data.eraseAfter).toLocaleString()}.`
                  : change.data.status === 'restored'
                    ? 'Account restored.'
                    : 'Erasure requested. The account is erased within minutes.'}{' '}
                {change.data.revokedSessions
                  ? `${change.data.revokedSessions} ${change.data.revokedSessions === 1 ? 'session' : 'sessions'} ended. `
                  : ''}
                Completed {new Date(change.data.completedAt).toLocaleString()}.
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="staff-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Alert tone="warning">
              <AlertDescription>
                {action === 'restore'
                  ? 'Recent staff authentication is required. Ended sessions stay ended.'
                  : 'Accounts that are the only owner of a workspace can’t be deleted until ownership is transferred or the workspace is closed. Recent staff authentication is required.'}
              </AlertDescription>
            </Alert>
            {action === 'schedule' ? (
              <Field>
                <FieldLabel id={`${ids}-category`}>Category</FieldLabel>
                <Select
                  aria-labelledby={`${ids}-category`}
                  options={deletionCategories}
                  value={category}
                  disabled={locked}
                  onValueChange={(value) => {
                    if (value) setCategory(value);
                  }}
                />
              </Field>
            ) : null}
            {needsReference ? (
              <Field>
                <FieldLabel htmlFor={`${ids}-reference`}>
                  Request reference
                </FieldLabel>
                <Input
                  id={`${ids}-reference`}
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  maxLength={200}
                  disabled={locked}
                  aria-invalid={!!errors.reference}
                  aria-describedby={`${ids}-reference-error`}
                />
                <FieldError
                  id={`${ids}-reference-error`}
                  errors={
                    errors.reference ? [{ message: errors.reference }] : []
                  }
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${ids}-reason`}>{text.reason}</FieldLabel>
              <Textarea
                id={`${ids}-reason`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                disabled={locked}
                aria-invalid={!!errors.reason}
                aria-describedby={`${ids}-reason-error`}
              />
              <FieldError
                id={`${ids}-reason-error`}
                errors={errors.reason ? [{ message: errors.reason }] : []}
              />
            </Field>
            {needsReference ? (
              <label className="staff-check">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  disabled={locked}
                />
                <span>{text.acknowledge}</span>
              </label>
            ) : null}
            {change.isError ? (
              <>
                <Failure error={change.error} />
                <p className="staff-muted">
                  Completion was not confirmed. Retry this request to retrieve
                  the original result safely.
                </p>
              </>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={onClose}
                disabled={change.isPending}
              >
                Cancel
              </Button>
              <Button
                variant={action === 'restore' ? 'default' : 'destructive'}
                type="submit"
                disabled={(needsReference && !acknowledged) || change.isPending}
              >
                {change.isPending
                  ? text.pending
                  : change.isError
                    ? 'Retry'
                    : text.submit}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
