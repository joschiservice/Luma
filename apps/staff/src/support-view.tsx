import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
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
import { z } from 'zod';

import { reasonSchema } from './access';
import { staffApi } from './api';
import { Failure } from './feedback';

const categories = [
  { value: 'security_incident', label: 'Security incident' },
  { value: 'legal_request', label: 'Legal request' },
] as const;

const durations = [
  { value: '24', label: '24 hours', hours: 24 },
  { value: '72', label: '3 days', hours: 72 },
  { value: '168', label: '7 days', hours: 168 },
] as const;

const referenceSchema = z
  .string()
  .trim()
  .min(3, 'Enter the incident, case or request reference.')
  .max(200, 'Use no more than 200 characters.');

/** Shows whether the workspace allows support views, and a pending request for it. */
export function SupportAccessStatus({
  access,
  canRequest,
  onRequest,
}: {
  access: {
    allowedUntil: string | null;
    request: { requestedAt: string; expiresAt: string } | null;
  };
  canRequest: boolean;
  onRequest: () => void;
}) {
  return (
    <section className="staff-section" aria-labelledby="workspace-support-view">
      <h2 id="workspace-support-view">Support view</h2>
      <Alert tone={access.allowedUntil ? 'success' : 'neutral'}>
        <AlertDescription>
          {access.allowedUntil
            ? `The workspace allows read-only support views until ${new Date(access.allowedUntil).toLocaleString()}. Use View as on a member to see what they see.`
            : access.request
              ? `Access was requested ${new Date(access.request.requestedAt).toLocaleString()} and waits for the workspace’s owners. The request lapses ${new Date(access.request.expiresAt).toLocaleString()}.`
              : 'The workspace doesn’t allow support views. Request access, or ask an owner to allow it in Settings › Luma support.'}
        </AlertDescription>
      </Alert>
      {canRequest && !access.allowedUntil && !access.request ? (
        <Button variant="outline" onClick={onRequest}>
          Request access
        </Button>
      ) : null}
    </section>
  );
}

/**
 * Starts a read-only support view as one member. Without consent, staff with the emergency
 * permission can start one for a security incident or legal request, with a reference.
 */
export function SupportViewDialog({
  workspaceId,
  grantId,
  member,
  consented,
  canConsent,
  canEmergency,
  onClose,
}: {
  workspaceId: string;
  grantId: string;
  member: { userId: string; name: string; email: string };
  consented: boolean;
  canConsent: boolean;
  canEmergency: boolean;
  onClose: () => void;
}) {
  const ids = { reason: useId(), category: useId(), reference: useId() };
  const [mode, setMode] = useState<'consent' | 'emergency'>(
    consented && canConsent ? 'consent' : 'emergency',
  );
  const [reason, setReason] = useState('');
  const [category, setCategory] =
    useState<(typeof categories)[number]['value']>('security_incident');
  const [reference, setReference] = useState('');
  const [errors, setErrors] = useState<{
    reason?: string | undefined;
    reference?: string | undefined;
  }>({});
  const start = useMutation({
    mutationFn: (body: Parameters<typeof staffApi.startSupportView>[2]) =>
      staffApi.startSupportView(workspaceId, member.userId, body),
  });
  const emergency = mode === 'emergency';

  function submit() {
    const checkedReason = reasonSchema.safeParse(reason);
    const checkedReference = referenceSchema.safeParse(reference);
    setErrors({
      ...(checkedReason.success
        ? {}
        : { reason: checkedReason.error.issues[0]?.message }),
      ...(emergency && !checkedReference.success
        ? { reference: checkedReference.error.issues[0]?.message }
        : {}),
    });
    if (!checkedReason.success || (emergency && !checkedReference.success))
      return;
    start.mutate(
      emergency
        ? {
            mode,
            grantId,
            reason: checkedReason.data,
            category,
            reference: checkedReference.data ?? '',
          }
        : { mode, grantId, reason: checkedReason.data },
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !start.isPending) onClose();
      }}
    >
      <DialogContent showCloseButton={!start.isPending}>
        <DialogHeader>
          <DialogTitle>View as {member.name}</DialogTitle>
          <DialogDescription>
            Open the customer app as {member.email}, read-only, for up to 30
            minutes. You see their permissions, Home and filters. Every change
            is refused, and every page you open appears in the workspace’s
            Activity.
          </DialogDescription>
        </DialogHeader>
        {start.isSuccess ? (
          <>
            <Alert tone="success" role="status">
              <AlertDescription>
                The view is ready until{' '}
                {new Date(start.data.expiresAt).toLocaleTimeString()}. Open it
                before{' '}
                {new Date(start.data.handoffExpiresAt).toLocaleTimeString()};
                the link works once.
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <a
                className={buttonVariants()}
                href={start.data.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open support view
              </a>
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
            {canEmergency ? (
              <fieldset className="staff-choices">
                <legend>Access</legend>
                <label className="staff-check">
                  <input
                    type="radio"
                    name="support-view-mode"
                    checked={mode === 'consent'}
                    disabled={!consented || !canConsent || start.isPending}
                    onChange={() => setMode('consent')}
                  />
                  <span>
                    With the workspace’s consent
                    {consented ? '' : ' (not allowed now)'}
                  </span>
                </label>
                <label className="staff-check">
                  <input
                    type="radio"
                    name="support-view-mode"
                    checked={emergency}
                    disabled={start.isPending}
                    onChange={() => setMode('emergency')}
                  />
                  <span>
                    Emergency access, for a security incident or legal request
                  </span>
                </label>
              </fieldset>
            ) : null}
            {emergency ? (
              <Alert tone="warning">
                <AlertDescription>
                  Emergency access doesn’t need the workspace’s consent. The
                  workspace’s owners are emailed when it ends, and it appears in
                  Activity. Recent staff sign-in is required.
                </AlertDescription>
              </Alert>
            ) : null}
            <Field>
              <FieldLabel htmlFor={ids.reason}>
                Reason or ticket reference
              </FieldLabel>
              <Textarea
                id={ids.reason}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={start.isPending}
                maxLength={500}
                aria-invalid={!!errors.reason}
                aria-describedby={`${ids.reason}-error`}
              />
              <FieldError
                id={`${ids.reason}-error`}
                errors={errors.reason ? [{ message: errors.reason }] : []}
              />
            </Field>
            {emergency ? (
              <>
                <Field>
                  <FieldLabel id={ids.category}>Emergency category</FieldLabel>
                  <Select
                    aria-labelledby={ids.category}
                    options={categories}
                    value={category}
                    disabled={start.isPending}
                    onValueChange={(value) => {
                      if (value) setCategory(value);
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={ids.reference}>
                    Incident, case or request reference
                  </FieldLabel>
                  <Input
                    id={ids.reference}
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    disabled={start.isPending}
                    maxLength={200}
                    aria-invalid={!!errors.reference}
                    aria-describedby={`${ids.reference}-error`}
                  />
                  <FieldError
                    id={`${ids.reference}-error`}
                    errors={
                      errors.reference ? [{ message: errors.reference }] : []
                    }
                  />
                </Field>
              </>
            ) : null}
            {start.isError ? <Failure error={start.error} /> : null}
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={onClose}
                disabled={start.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={emergency ? 'destructive' : 'default'}
                disabled={start.isPending || (!emergency && !consented)}
              >
                {start.isPending
                  ? 'Starting…'
                  : emergency
                    ? 'Start emergency view'
                    : 'Start support view'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Asks the workspace's owners to allow support views for a chosen period. */
export function SupportAccessRequestDialog({
  workspaceId,
  grantId,
  onClose,
}: {
  workspaceId: string;
  grantId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const ids = { reason: useId(), duration: useId() };
  const [reason, setReason] = useState('');
  const [duration, setDuration] =
    useState<(typeof durations)[number]['value']>('24');
  const [error, setError] = useState<string | undefined>();
  const request = useMutation({
    mutationFn: (body: { reason: string; durationHours: 24 | 72 | 168 }) =>
      staffApi.requestSupportAccess(workspaceId, { grantId, ...body }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ['staff', 'workspace', workspaceId, grantId],
      }),
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !request.isPending) onClose();
      }}
    >
      <DialogContent showCloseButton={!request.isPending}>
        <DialogHeader>
          <DialogTitle>Request support access</DialogTitle>
          <DialogDescription>
            Ask the workspace’s owners and admins to allow read-only support
            views. Owners are emailed, and your reason is shown to them. The
            request lapses after seven days.
          </DialogDescription>
        </DialogHeader>
        {request.isSuccess ? (
          <>
            <Alert tone="success" role="status">
              <AlertDescription>
                Access requested. It lapses{' '}
                {new Date(request.data.expiresAt).toLocaleString()}.
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
              const checked = reasonSchema.safeParse(reason);
              setError(
                checked.success ? undefined : checked.error.issues[0]?.message,
              );
              const hours = durations.find(
                (item) => item.value === duration,
              )?.hours;
              if (checked.success && hours)
                request.mutate({ reason: checked.data, durationHours: hours });
            }}
          >
            <Field>
              <FieldLabel htmlFor={ids.reason}>
                Why support needs access
              </FieldLabel>
              <Textarea
                id={ids.reason}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={request.isPending}
                maxLength={500}
                aria-invalid={!!error}
                aria-describedby={`${ids.reason}-error`}
              />
              <FieldError
                id={`${ids.reason}-error`}
                errors={error ? [{ message: error }] : []}
              />
            </Field>
            <Field>
              <FieldLabel id={ids.duration}>Access for</FieldLabel>
              <Select
                aria-labelledby={ids.duration}
                options={durations}
                value={duration}
                disabled={request.isPending}
                onValueChange={(value) => {
                  if (value) setDuration(value);
                }}
              />
            </Field>
            {request.isError ? <Failure error={request.error} /> : null}
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={onClose}
                disabled={request.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={request.isPending}>
                {request.isPending ? 'Requesting…' : 'Request access'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
