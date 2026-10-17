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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { z } from 'zod';

import { reasonSchema } from './access';
import {
  type OpenAccessBody,
  staffApiForRegion,
  useRegionalStaffApi,
} from './api';
import { Failure, Loading } from './feedback';
import { staffRegion } from './regions';

/** What staff ask to inspect: a workspace's records or one person's account. */
export type InspectionTarget =
  { kind: 'workspace'; id: string } | { kind: 'account'; id: string };

const categories = [
  { value: 'security_incident', label: 'Security incident' },
  { value: 'legal_request', label: 'Legal request' },
] as const;

const referenceSchema = z
  .string()
  .trim()
  .min(3, 'Enter the incident, case or request reference.')
  .max(200, 'Use no more than 200 characters.');

const dateTime = (value: string) => new Date(value).toLocaleString();

/** Who answers a request, as staff should describe them. */
const approver = (target: InspectionTarget) =>
  target.kind === 'workspace'
    ? 'the workspace’s owners and admins'
    : 'the account holder';

/** Reads your latest inspection request for the target; polls while it waits for an answer. */
function useLatestRequest(target: InspectionTarget) {
  const staffApi = useRegionalStaffApi();

  return useQuery({
    queryKey: [
      'staff',
      staffRegion(),
      target.kind,
      target.id,
      'access-request',
    ],
    queryFn: ({ signal }) =>
      target.kind === 'workspace'
        ? staffApi.accessRequest(target.id, signal)
        : staffApi.accountAccessRequest(target.id, signal),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      query.state.data?.status === 'pending' ? 15_000 : false,
  });
}

/** Opens a grant for this session and shows the target's records under it. */
function useOpenAccess(target: InspectionTarget, onOpened?: () => void) {
  const staffApi = useRegionalStaffApi();
  const navigate = useNavigate();
  const client = useQueryClient();

  return useMutation({
    mutationFn: async (body: OpenAccessBody): Promise<{ id: string }> =>
      target.kind === 'workspace'
        ? staffApi.openAccess(target.id, body)
        : staffApi.openAccountAccess(target.id, body),
    onSuccess: async (grant) => {
      const region = staffRegion();
      client.setQueryData(
        ['staff', region, 'grant', target.id, grant.id],
        grant,
      );
      onOpened?.();
      if (target.kind === 'workspace')
        await navigate({
          to: '/workspaces/$workspaceId',
          params: { workspaceId: target.id },
          search: { region, grantId: grant.id },
        });
      else
        await navigate({
          to: '/accounts/$userId',
          params: { userId: target.id },
          search: { region, grantId: grant.id },
        });
    },
  });
}

/**
 * Shows your latest inspection request for a workspace or account and its next step: request,
 * wait for the customer's answer, open approved access, or request again. Staff with
 * `staff.inspect.emergency` can open emergency access instead.
 */
export function InspectionAccess({
  target,
  canEmergency,
}: {
  target: InspectionTarget;
  canEmergency: boolean;
}) {
  const latest = useLatestRequest(target);
  const open = useOpenAccess(target);
  const [dialog, setDialog] = useState<'request' | 'emergency' | null>(null);
  const request = latest.data;
  const noun = target.kind === 'workspace' ? 'workspace' : 'account';

  return (
    <section className="staff-section" aria-labelledby="inspection-access">
      <h2 id="inspection-access">Inspection access</h2>
      {latest.isPending ? (
        <Loading>Checking your inspection request…</Loading>
      ) : latest.isError ? (
        <Failure error={latest.error} retry={() => void latest.refetch()} />
      ) : !request ? (
        <p className="staff-muted">
          Customer details need approval. Ask {approver(target)} for 30 minutes
          of read-only access.
        </p>
      ) : request.status === 'pending' ? (
        <Alert role="status">
          <AlertDescription>
            Waiting for approval from {approver(target)}. Requested{' '}
            {dateTime(request.requestedAt)}; the request lapses{' '}
            {dateTime(request.expiresAt)} if nobody answers.
          </AlertDescription>
        </Alert>
      ) : request.status === 'approved' && request.accessExpiresAt ? (
        <Alert tone="success" role="status">
          <AlertDescription>
            {request.mode === 'emergency'
              ? 'Emergency access is open'
              : 'Approved'}{' '}
            until {dateTime(request.accessExpiresAt)}.
          </AlertDescription>
        </Alert>
      ) : request.status === 'declined' ? (
        <Alert tone="warning" role="status">
          <AlertDescription>
            Your request was declined
            {request.decidedAt ? ` on ${dateTime(request.decidedAt)}` : ''}.
          </AlertDescription>
        </Alert>
      ) : request.status === 'revoked' ? (
        <Alert tone="warning" role="status">
          <AlertDescription>
            The customer revoked your access
            {request.revokedAt ? ` on ${dateTime(request.revokedAt)}` : ''}.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert tone="warning" role="status">
          <AlertDescription>
            {request.decidedAt
              ? `Your approved access ended${request.accessExpiresAt ? ` on ${dateTime(request.accessExpiresAt)}` : ''}.`
              : 'Your request lapsed without an answer.'}
          </AlertDescription>
        </Alert>
      )}
      {open.isError ? <Failure error={open.error} /> : null}
      <div className="staff-actions">
        {request?.status === 'approved' ? (
          <Button
            disabled={open.isPending}
            onClick={() => open.mutate({ requestId: request.id })}
          >
            {open.isPending ? 'Opening access…' : `Open ${noun}`}
          </Button>
        ) : request?.status === 'pending' ? (
          <Button
            variant="outline"
            disabled={latest.isFetching}
            onClick={() => void latest.refetch()}
          >
            Check again
          </Button>
        ) : latest.isSuccess ? (
          <Button onClick={() => setDialog('request')}>
            {request ? 'Request again' : 'Request inspection'}
          </Button>
        ) : null}
        {canEmergency && request?.status !== 'approved' ? (
          <Button variant="outline" onClick={() => setDialog('emergency')}>
            Emergency access
          </Button>
        ) : null}
      </div>
      {dialog === 'request' ? (
        <InspectionRequestDialog
          target={target}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'emergency' ? (
        <EmergencyAccessDialog
          target={target}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </section>
  );
}

/**
 * Asks the customer to approve inspection in `region`. `afterRequest` runs once the request is
 * sent, and also when one is already pending or approved, so callers can show its state.
 */
export function InspectionRequestDialog({
  target,
  name,
  region = staffRegion(),
  afterRequest,
  onClose,
}: {
  target: InspectionTarget;
  name?: string;
  region?: ReturnType<typeof staffRegion>;
  afterRequest?: () => Promise<void>;
  onClose: () => void;
}) {
  const staffApi = staffApiForRegion(region);
  const client = useQueryClient();
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const ask = useMutation({
    mutationFn: (value: string) =>
      target.kind === 'workspace'
        ? staffApi.requestAccess(target.id, value)
        : staffApi.requestAccountAccess(target.id, value),
    onSettled: () =>
      client.invalidateQueries({
        queryKey: ['staff', region, target.kind, target.id, 'access-request'],
      }),
    onSuccess: async () => {
      onClose();
      await afterRequest?.();
    },
    onError: async (failure) => {
      // An existing request answers the same need; show its state instead.
      if (
        afterRequest &&
        failure instanceof Error &&
        'status' in failure &&
        failure.status === 409
      ) {
        onClose();
        await afterRequest();
      }
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !ask.isPending) onClose();
      }}
    >
      <DialogContent showCloseButton={!ask.isPending}>
        <DialogHeader>
          <DialogTitle>
            Request inspection{name ? ` of ${name}` : ''}
          </DialogTitle>
          <DialogDescription>
            {target.kind === 'workspace'
              ? 'The workspace’s owners and admins see your reason and approve or decline in Luma. Owners are emailed.'
              : 'The account holder sees your reason and approves or declines in Settings › Security. They are emailed.'}{' '}
            Approved access lasts 30 minutes from approval. Requests lapse after
            24 hours. Your identity, reason and reads are recorded.
          </DialogDescription>
        </DialogHeader>
        <form
          className="staff-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const checked = reasonSchema.safeParse(reason);
            setError(
              checked.success ? undefined : checked.error.issues[0]?.message,
            );
            if (checked.success) ask.mutate(checked.data);
          }}
        >
          <Field>
            <FieldLabel htmlFor={id}>
              Support reason or ticket reference
            </FieldLabel>
            <Textarea
              id={id}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={ask.isPending}
              maxLength={500}
              aria-invalid={!!error}
              aria-describedby={`${id}-error`}
            />
            <FieldError
              id={`${id}-error`}
              errors={error ? [{ message: error }] : []}
            />
          </Field>
          {ask.isError ? <Failure error={ask.error} /> : null}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={onClose}
              disabled={ask.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={ask.isPending}>
              {ask.isPending ? 'Sending request…' : 'Send request'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Opens thirty minutes of access without approval, for a security incident or legal request. */
function EmergencyAccessDialog({
  target,
  onClose,
}: {
  target: InspectionTarget;
  onClose: () => void;
}) {
  const open = useOpenAccess(target, onClose);
  const ids = { reason: useId(), category: useId(), reference: useId() };
  const [reason, setReason] = useState('');
  const [category, setCategory] =
    useState<(typeof categories)[number]['value']>('security_incident');
  const [reference, setReference] = useState('');
  const [errors, setErrors] = useState<{
    reason?: string | undefined;
    reference?: string | undefined;
  }>({});

  function submit() {
    const checkedReason = reasonSchema.safeParse(reason);
    const checkedReference = referenceSchema.safeParse(reference);
    setErrors({
      ...(checkedReason.success
        ? {}
        : { reason: checkedReason.error.issues[0]?.message }),
      ...(checkedReference.success
        ? {}
        : { reference: checkedReference.error.issues[0]?.message }),
    });
    if (!checkedReason.success || !checkedReference.success) return;
    open.mutate({
      reason: checkedReason.data,
      emergency: { category, reference: checkedReference.data },
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !open.isPending) onClose();
      }}
    >
      <DialogContent showCloseButton={!open.isPending}>
        <DialogHeader>
          <DialogTitle>Emergency access</DialogTitle>
          <DialogDescription>
            Opens 30 minutes of read-only access without approval, only for a
            security incident or legal request.
          </DialogDescription>
        </DialogHeader>
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
              {target.kind === 'workspace'
                ? 'The workspace’s Activity records emergency access with its category, and its owners are emailed.'
                : 'The person’s security activity records emergency access with its category, and they are emailed.'}{' '}
              They can’t revoke it. You must have signed in within the last 15
              minutes.
            </AlertDescription>
          </Alert>
          <Field>
            <FieldLabel id={ids.category}>Emergency category</FieldLabel>
            <Select
              aria-labelledby={ids.category}
              options={categories}
              value={category}
              disabled={open.isPending}
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
              disabled={open.isPending}
              maxLength={200}
              aria-invalid={!!errors.reference}
              aria-describedby={`${ids.reference}-error`}
            />
            <FieldError
              id={`${ids.reference}-error`}
              errors={errors.reference ? [{ message: errors.reference }] : []}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={ids.reason}>Reason</FieldLabel>
            <Textarea
              id={ids.reason}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={open.isPending}
              maxLength={500}
              aria-invalid={!!errors.reason}
              aria-describedby={`${ids.reason}-error`}
            />
            <FieldError
              id={`${ids.reason}-error`}
              errors={errors.reason ? [{ message: errors.reason }] : []}
            />
          </Field>
          {open.isError ? <Failure error={open.error} /> : null}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={onClose}
              disabled={open.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={open.isPending}
            >
              {open.isPending ? 'Opening access…' : 'Open emergency access'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
