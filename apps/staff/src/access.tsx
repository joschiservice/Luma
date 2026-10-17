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
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';

import { useRegionalStaffApi } from './api';
import { Failure } from './feedback';
import { staffRegion } from './regions';

export const reasonSchema = z
  .string()
  .trim()
  .min(10, 'Explain the support reason in at least 10 characters.')
  .max(500, 'Use no more than 500 characters.');

/** Requires an explicit global-effect acknowledgement and retains an idempotency key on retry. */
export function RevokeSessionsDialog({
  workspaceId,
  grantId,
  userId,
  email,
  onClose,
}: {
  workspaceId: string;
  grantId: string;
  userId: string;
  email: string;
  onClose: () => void;
}) {
  const staffApi = useRegionalStaffApi();
  const [commandId] = useState(() => crypto.randomUUID());
  const revoke = useMutation({
    mutationFn: (reason: string) =>
      staffApi.revokeSessions(workspaceId, userId, {
        grantId,
        reason,
        commandId,
        acknowledgeGlobalEffect: true,
      }),
  });
  const form = useForm({
    defaultValues: { reason: '', acknowledge: false },
    onSubmit: async ({ value }) => {
      if (!value.acknowledge) return;
      try {
        await revoke.mutateAsync(reasonSchema.parse(value.reason));
      } catch {
        /* Keep this dialog and command ID for safe retries. */
      }
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !revoke.isPending) onClose();
      }}
    >
      <DialogContent showCloseButton={!revoke.isPending}>
        <DialogHeader>
          <DialogTitle>Revoke customer sessions</DialogTitle>
          <DialogDescription>
            Sign {email} out of Luma on all devices. This affects every
            workspace this account belongs to.
          </DialogDescription>
        </DialogHeader>
        {revoke.isSuccess ? (
          <>
            <Alert tone="success" role="status">
              <AlertDescription>
                {revoke.data.revokedSessions}{' '}
                {revoke.data.revokedSessions === 1
                  ? 'session revoked'
                  : 'sessions revoked'}
                . Completed {new Date(revoke.data.completedAt).toLocaleString()}
                .
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
              void form.handleSubmit();
            }}
          >
            <Alert tone="warning">
              <AlertDescription>
                This is an account-wide operation. Recent staff authentication
                is required.
              </AlertDescription>
            </Alert>
            <form.Field name="reason" validators={{ onChange: reasonSchema }}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="revoke-reason">
                    Reason for revoking sessions
                  </FieldLabel>
                  <Textarea
                    id="revoke-reason"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    maxLength={500}
                    disabled={revoke.isPending || revoke.isError}
                    aria-invalid={field.state.meta.errors.length > 0}
                    aria-describedby="revoke-reason-error"
                  />
                  <FieldError
                    id="revoke-reason-error"
                    errors={field.state.meta.errors}
                  />
                </Field>
              )}
            </form.Field>
            <form.Field name="acknowledge">
              {(field) => (
                <label className="staff-check">
                  <input
                    type="checkbox"
                    checked={field.state.value}
                    onChange={(event) =>
                      field.handleChange(event.target.checked)
                    }
                    disabled={revoke.isPending}
                  />
                  <span>
                    I understand that this signs the customer out across all
                    their workspaces.
                  </span>
                </label>
              )}
            </form.Field>
            {revoke.isError ? (
              <>
                <Failure error={revoke.error} />
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
                disabled={revoke.isPending}
              >
                Cancel
              </Button>
              <form.Subscribe selector={(state) => state.values.acknowledge}>
                {(acknowledge) => (
                  <Button
                    variant="destructive"
                    type="submit"
                    disabled={!acknowledge || revoke.isPending}
                  >
                    {revoke.isPending
                      ? 'Revoking sessions…'
                      : revoke.isError
                        ? 'Retry revocation'
                        : 'Revoke all sessions'}
                  </Button>
                )}
              </form.Subscribe>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Suspends or reactivates one membership with a reason. Keeps one command ID for safe retries.
 * Suspending the only active owner needs an explicit acknowledgement.
 */
export function MembershipDialog({
  workspaceId,
  grantId,
  member,
  action,
  soleOwner,
  onClose,
}: {
  workspaceId: string;
  grantId: string;
  member: { userId: string; email: string };
  action: 'suspend' | 'reactivate';
  soleOwner: boolean;
  onClose: () => void;
}) {
  const staffApi = useRegionalStaffApi();
  const client = useQueryClient();
  const [commandId] = useState(() => crypto.randomUUID());
  const suspend = action === 'suspend';
  const acknowledgement = suspend && soleOwner;
  const change = useMutation({
    mutationFn: (value: { reason: string; acknowledge: boolean }) =>
      staffApi.changeMembership(workspaceId, member.userId, action, {
        grantId,
        reason: value.reason,
        commandId,
        ...(suspend ? { acknowledgeLastOwner: value.acknowledge } : {}),
      }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ['staff', staffRegion(), 'workspace', workspaceId, grantId],
      }),
  });
  const form = useForm({
    defaultValues: { reason: '', acknowledge: false },
    onSubmit: async ({ value }) => {
      if (acknowledgement && !value.acknowledge) return;
      try {
        await change.mutateAsync({
          reason: reasonSchema.parse(value.reason),
          acknowledge: value.acknowledge,
        });
      } catch {
        /* Keep this dialog and command ID for safe retries. */
      }
    },
  });

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
            {suspend ? 'Suspend membership' : 'Reactivate membership'}
          </DialogTitle>
          <DialogDescription>
            {suspend
              ? `Remove ${member.email}’s access to this workspace. Their account, their other workspaces and their role here are kept. Workflows that run with their access pause.`
              : `Restore ${member.email}’s access to this workspace with the role they had. Paused workflows that run with their access continue.`}
          </DialogDescription>
        </DialogHeader>
        {change.isSuccess ? (
          <>
            <Alert tone="success" role="status">
              <AlertDescription>
                {change.data.status === 'suspended'
                  ? 'Membership suspended'
                  : 'Membership reactivated'}
                . Completed {new Date(change.data.completedAt).toLocaleString()}
                .
                {change.data.lastActiveOwner
                  ? ' The workspace has no active owner until ownership is transferred or this membership is reactivated.'
                  : ''}
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
              void form.handleSubmit();
            }}
          >
            <Alert tone="warning">
              <AlertDescription>
                The customer’s workspace Activity shows this change by Luma
                support. Recent staff authentication is required.
              </AlertDescription>
            </Alert>
            <form.Field name="reason" validators={{ onChange: reasonSchema }}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="membership-reason">
                    {suspend
                      ? 'Reason for suspending access'
                      : 'Reason for reactivating access'}
                  </FieldLabel>
                  <Textarea
                    id="membership-reason"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    maxLength={500}
                    disabled={change.isPending || change.isError}
                    aria-invalid={field.state.meta.errors.length > 0}
                    aria-describedby="membership-reason-error"
                  />
                  <FieldError
                    id="membership-reason-error"
                    errors={field.state.meta.errors}
                  />
                </Field>
              )}
            </form.Field>
            {acknowledgement ? (
              <form.Field name="acknowledge">
                {(field) => (
                  <label className="staff-check">
                    <input
                      type="checkbox"
                      checked={field.state.value}
                      onChange={(event) =>
                        field.handleChange(event.target.checked)
                      }
                      disabled={change.isPending || change.isError}
                    />
                    <span>
                      I understand that this is the only active owner, and the
                      workspace will have no active owner until ownership is
                      transferred.
                    </span>
                  </label>
                )}
              </form.Field>
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
              <form.Subscribe selector={(state) => state.values.acknowledge}>
                {(acknowledged) => (
                  <Button
                    variant={suspend ? 'destructive' : 'default'}
                    type="submit"
                    disabled={
                      (acknowledgement && !acknowledged) || change.isPending
                    }
                  >
                    {change.isPending
                      ? suspend
                        ? 'Suspending…'
                        : 'Reactivating…'
                      : change.isError
                        ? 'Retry'
                        : suspend
                          ? 'Suspend membership'
                          : 'Reactivate membership'}
                  </Button>
                )}
              </form.Subscribe>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
