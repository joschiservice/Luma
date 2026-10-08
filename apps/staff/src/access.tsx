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
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';

import { staffApi } from './api';
import { Failure } from './feedback';

const reasonSchema = z
  .string()
  .trim()
  .min(10, 'Explain the support reason in at least 10 characters.')
  .max(500, 'Use no more than 500 characters.');

/** Requests auditable, workspace-scoped access before displaying customer details. */
export function AccessDialog({
  workspaceId,
  name,
  onClose,
}: {
  workspaceId: string;
  name: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const access = useMutation({
    mutationFn: (reason: string) => staffApi.grant(workspaceId, reason),
    onSuccess: async (grant) => {
      client.setQueryData(['staff', 'grant', workspaceId, grant.id], grant);
      onClose();
      await navigate({
        to: '/workspaces/$workspaceId',
        params: { workspaceId },
        search: { grantId: grant.id },
      });
    },
  });
  const form = useForm({
    defaultValues: { reason: '' },
    onSubmit: async ({ value }) => {
      try {
        await access.mutateAsync(reasonSchema.parse(value.reason));
      } catch {
        /* Mutation and field feedback describe the failed request. */
      }
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !access.isPending) onClose();
      }}
    >
      <DialogContent showCloseButton={!access.isPending}>
        <DialogHeader>
          <DialogTitle>Inspect {name}</DialogTitle>
          <DialogDescription>
            Open time-limited support access to this workspace. Your identity,
            reason and subsequent operations are recorded.
          </DialogDescription>
        </DialogHeader>
        <form
          className="staff-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="reason" validators={{ onChange: reasonSchema }}>
            {(field) => (
              <Field>
                <FieldLabel htmlFor="access-reason">
                  Support reason or ticket reference
                </FieldLabel>
                <Textarea
                  id="access-reason"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  disabled={access.isPending}
                  maxLength={500}
                  aria-invalid={field.state.meta.errors.length > 0}
                  aria-describedby="access-reason-error"
                />
                <FieldError
                  id="access-reason-error"
                  errors={field.state.meta.errors}
                />
              </Field>
            )}
          </form.Field>
          {access.isError ? <Failure error={access.error} /> : null}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={onClose}
              disabled={access.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={access.isPending}>
              {access.isPending ? 'Opening access…' : 'Open support access'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
