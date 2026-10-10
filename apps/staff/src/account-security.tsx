import type { staffAccountSecurityEventsSchema } from '@luma/api-contract/staff';
import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { z } from 'zod';

import { Failure, Loading } from './feedback';
import { accountSecurityEventsOptions } from './queries';

type SecurityEvent = z.infer<
  typeof staffAccountSecurityEventsSchema
>['items'][number];

const eventLabels: Record<SecurityEvent['type'], string> = {
  'sign-in.password': 'Password sign-in',
  'sign-in.passkey': 'Passkey sign-in',
  'sign-in.two-factor': 'Two-factor sign-in step',
  'two-factor.enabled': 'Two-factor authentication turned on',
  'two-factor.disabled': 'Two-factor authentication turned off',
  'two-factor.backup-codes-regenerated': 'Backup codes replaced',
  'passkey.added': 'Passkey added',
  'passkey.removed': 'Passkey removed',
  'password.changed': 'Password changed',
  'password.reset': 'Password reset',
  'sessions.revoked': 'Sessions signed out by the customer',
  'sessions.revoked-by-staff': 'Sessions revoked by staff',
  'account.disabled': 'Account disabled by staff',
  'account.enabled': 'Account enabled by staff',
  'account.deletion-scheduled': 'Account scheduled for deletion by staff',
  'account.restored': 'Account restored by staff',
};

const reasonLabels: Record<string, string> = {
  'invalid-credentials': 'Wrong email or password',
  'invalid-code': 'Wrong code',
  'too-many-attempts': 'Too many codes',
  locked: 'Code entry locked',
  'challenge-expired': 'Sign-in attempt expired',
  'passkey-rejected': 'Passkey not accepted',
  'account-disabled': 'Account disabled',
  rejected: 'Rejected',
  'second-factor-required': 'Password accepted, code requested',
  'authenticator-code': 'Authenticator code',
  'backup-code': 'Backup code',
  one: 'One session',
  others: 'All other sessions',
  all: 'All sessions',
};

function device(row: SecurityEvent) {
  const name =
    row.browser && row.os
      ? `${row.browser} on ${row.os}`
      : (row.browser ?? row.os);

  return [name, row.ipAddress].filter(Boolean).join(' · ') || 'Not kept';
}

/** Pages through an account's security events under the current account grant. */
export function AccountSecurityEvents({
  userId,
  grantId,
}: {
  userId: string;
  grantId: string;
}) {
  const events = useInfiniteQuery(
    accountSecurityEventsOptions(userId, grantId),
  );
  const rows = events.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="staff-section" aria-labelledby="account-security">
      <h2 id="account-security">Security activity</h2>
      <p className="staff-muted">
        Sign-ins, failed attempts and security changes. IP addresses and devices
        are kept for 90 days, events for one year.
      </p>
      {events.isPending ? (
        <Loading>Reading security activity…</Loading>
      ) : events.isError && !rows.length ? (
        <Failure error={events.error} retry={() => void events.refetch()} />
      ) : (
        <>
          <DataTable
            caption="Account security activity"
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'event',
                header: 'Event',
                cell: (row) => (
                  <div>
                    {eventLabels[row.type]}
                    {row.reason ? (
                      <p className="staff-muted">
                        {reasonLabels[row.reason] ?? row.reason}
                      </p>
                    ) : null}
                  </div>
                ),
              },
              {
                key: 'outcome',
                header: 'Outcome',
                cell: (row) => (
                  <Badge tone={row.outcome === 'failed' ? 'danger' : 'neutral'}>
                    {row.outcome === 'failed' ? 'Failed' : 'Succeeded'}
                  </Badge>
                ),
              },
              {
                key: 'time',
                header: 'Time',
                cell: (row) => new Date(row.createdAt).toLocaleString(),
              },
              {
                key: 'device',
                header: 'Device and IP address',
                hideOnNarrow: true,
                cell: device,
              },
              {
                key: 'request',
                header: 'Request ID',
                hideOnNarrow: true,
                cell: (row) => (
                  <span className="staff-muted">{row.requestId}</span>
                ),
              },
            ]}
            empty={
              <Empty>
                <h3>No security activity</h3>
                <p>
                  No events were recorded for this account in the last year.
                </p>
              </Empty>
            }
          />
          {events.isError ? (
            <Alert tone="warning" role="alert">
              <AlertDescription>
                Older events could not be read. Try again.
              </AlertDescription>
            </Alert>
          ) : null}
          {events.hasNextPage ? (
            <Button
              variant="outline"
              onClick={() => void events.fetchNextPage()}
              disabled={events.isFetchingNextPage}
            >
              {events.isFetchingNextPage
                ? 'Reading older events…'
                : 'Show older events'}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
