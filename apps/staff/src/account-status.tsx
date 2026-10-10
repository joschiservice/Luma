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
import { Select } from '@luma/ui/components/primitives/select';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { reasonSchema } from './access';
import { staffApi } from './api';
import { Failure } from './feedback';

/** Why an account is disabled; staff see it, the customer never does. */
export const disableCategories = [
  { value: 'compromised', label: 'Compromised account' },
  { value: 'abuse', label: 'Abuse' },
  { value: 'fraud', label: 'Fraud' },
  { value: 'legal_request', label: 'Legal request' },
  { value: 'other', label: 'Other' },
] as const;

/** Names a stored disable category. */
export function categoryLabel(value: string) {
  return (
    disableCategories.find((category) => category.value === value)?.label ??
    value
  );
}

/**
 * Disables or enables one customer account with a reason. Disabling needs a category and an
 * acknowledgement that every workspace is affected. Keeps one command ID for safe retries.
 */
export function AccountStatusDialog({
  userId,
  grantId,
  email,
  action,
  onClose,
}: {
  userId: string;
  grantId: string;
  email: string;
  action: 'disable' | 'enable';
  onClose: () => void;
}) {
  const client = useQueryClient();
  const ids = useId();
  const disable = action === 'disable';
  const [commandId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [category, setCategory] =
    useState<(typeof disableCategories)[number]['value']>('compromised');
  const [acknowledged, setAcknowledged] = useState(false);
  const change = useMutation({
    mutationFn: (value: string) =>
      staffApi.changeAccount(
        userId,
        disable
          ? { action, grantId, commandId, reason: value, category }
          : { action, grantId, commandId, reason: value },
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ['staff', 'account', userId] }),
  });
  // A failed request keeps its inputs: a retry with the same command ID returns the original result.
  const locked = change.isPending || change.isError;

  function submit() {
    const parsed = reasonSchema.safeParse(reason);
    setReasonError(parsed.success ? null : parsed.error.issues[0]!.message);
    if (!parsed.success || (disable && !acknowledged)) return;
    change.mutate(parsed.data);
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
          <DialogTitle>
            {disable ? 'Disable account' : 'Enable account'}
          </DialogTitle>
          <DialogDescription>
            {disable
              ? `Sign ${email} out everywhere and refuse new sign-ins. Every workspace rejects them, and workflows that run with their access pause. Their memberships and roles are kept.`
              : `Allow ${email} to sign in again. They regain access to every workspace they belong to, with the same roles, and paused workflows continue.`}
          </DialogDescription>
        </DialogHeader>
        {change.isSuccess ? (
          <>
            <Alert tone="success" role="status">
              <AlertDescription>
                {change.data.status === 'disabled'
                  ? `Account disabled. ${change.data.revokedSessions} ${change.data.revokedSessions === 1 ? 'session' : 'sessions'} ended.`
                  : 'Account enabled.'}{' '}
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
                {disable
                  ? 'The customer is told only that their account is disabled and to contact their workspace owner or Luma support. Recent staff authentication is required.'
                  : 'Recent staff authentication is required.'}
              </AlertDescription>
            </Alert>
            {disable ? (
              <Field>
                <FieldLabel id={`${ids}-category`}>Category</FieldLabel>
                <Select
                  aria-labelledby={`${ids}-category`}
                  options={disableCategories}
                  value={category}
                  disabled={locked}
                  onValueChange={(value) => {
                    if (value) setCategory(value);
                  }}
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${ids}-reason`}>
                {disable
                  ? 'Reason for disabling the account'
                  : 'Reason for enabling the account'}
              </FieldLabel>
              <Textarea
                id={`${ids}-reason`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                disabled={locked}
                aria-invalid={reasonError !== null}
                aria-describedby={`${ids}-reason-error`}
              />
              <FieldError
                id={`${ids}-reason-error`}
                errors={reasonError ? [{ message: reasonError }] : []}
              />
            </Field>
            {disable ? (
              <label className="staff-check">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  disabled={locked}
                />
                <span>
                  I understand that this locks the person out of all their
                  workspaces until the account is enabled.
                </span>
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
                variant={disable ? 'destructive' : 'default'}
                type="submit"
                disabled={(disable && !acknowledged) || change.isPending}
              >
                {change.isPending
                  ? disable
                    ? 'Disabling…'
                    : 'Enabling…'
                  : change.isError
                    ? 'Retry'
                    : disable
                      ? 'Disable account'
                      : 'Enable account'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
