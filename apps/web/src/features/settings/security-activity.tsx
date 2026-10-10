import type { SecurityEventResponse } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

export const securityActivityKey = ['private', 'security-activity'] as const;

/** Pages through the signed-in person's own security events, newest first. */
export const securityActivityOptions = () =>
  infiniteQueryOptions({
    ...privateQueryDefaults,
    queryKey: securityActivityKey,
    queryFn: ({ pageParam, signal }) =>
      api.identity.listSecurityEvents(
        { query: pageParam ? { cursor: pageParam } : {} },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

function eventLabel(event: SecurityEventResponse) {
  const failed = event.outcome === 'failed';
  switch (event.type) {
    case 'sign-in.password':
      return failed
        ? m.settings_security_event_password_failed()
        : event.reason === 'second-factor-required'
          ? m.settings_security_event_password_pending()
          : m.settings_security_event_password_succeeded();
    case 'sign-in.passkey':
      return failed
        ? m.settings_security_event_passkey_failed()
        : m.settings_security_event_passkey_succeeded();
    case 'sign-in.two-factor':
      return failed
        ? m.settings_security_event_code_failed()
        : event.reason === 'backup-code'
          ? m.settings_security_event_backup_code_succeeded()
          : m.settings_security_event_code_succeeded();
    case 'two-factor.enabled':
      return m.settings_security_event_two_factor_enabled();
    case 'two-factor.disabled':
      return m.settings_security_event_two_factor_disabled();
    case 'two-factor.backup-codes-regenerated':
      return m.settings_security_event_backup_codes();
    case 'passkey.added':
      return m.settings_security_event_passkey_added();
    case 'passkey.removed':
      return m.settings_security_event_passkey_removed();
    case 'password.changed':
      return m.settings_security_event_password_changed();
    case 'sessions.revoked':
      return event.reason === 'one'
        ? m.settings_security_event_signed_out_one()
        : event.reason === 'all'
          ? m.settings_security_event_signed_out_all()
          : m.settings_security_event_signed_out_others();
    case 'sessions.revoked-by-staff':
      return m.settings_security_event_signed_out_by_support();
    case 'account.disabled':
      return m.settings_security_event_account_disabled();
    case 'account.enabled':
      return m.settings_security_event_account_enabled();
  }
}

function failureReason(reason: string | null) {
  switch (reason) {
    case 'invalid-credentials':
      return m.settings_security_reason_invalid_credentials();
    case 'invalid-code':
      return m.settings_security_reason_invalid_code();
    case 'too-many-attempts':
      return m.settings_security_reason_too_many_attempts();
    case 'locked':
      return m.settings_security_reason_locked();
    case 'challenge-expired':
      return m.settings_security_reason_challenge_expired();
    case 'passkey-rejected':
      return m.settings_security_reason_passkey_rejected();
    case 'account-disabled':
      return m.settings_security_reason_account_disabled();
    default:
      return m.settings_security_reason_rejected();
  }
}

function deviceLabel(event: SecurityEventResponse) {
  if (event.bySupport) return null;
  const device =
    event.browser && event.os
      ? `${event.browser} · ${event.os}`
      : (event.browser ?? event.os);
  if (!device && !event.ipAddress)
    return m.settings_security_activity_network_cleared();

  return [
    device ?? m.settings_security_activity_device_unknown(),
    event.ipAddress,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Lists the signed-in person's recent sign-ins and security changes; never other accounts. */
export function SecurityActivity() {
  const activity = useInfiniteQuery(securityActivityOptions());
  const events = activity.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <div>
          <h3>{m.settings_security_activity_title()}</h3>
          <p>{m.settings_security_activity_description()}</p>
        </div>
      </div>
      {activity.isPending ? (
        <p className="settings-note settings-security-row" role="status">
          {m.settings_security_activity_loading()}
        </p>
      ) : activity.isError && !events.length ? (
        <div className="settings-security-row">
          <Alert tone="danger" role="alert">
            {m.settings_security_activity_failed()}{' '}
            <Button variant="outline" onClick={() => void activity.refetch()}>
              {m.common_retry()}
            </Button>
          </Alert>
        </div>
      ) : events.length ? (
        <ul
          className="settings-passkeys"
          aria-label={m.settings_security_activity_list()}
        >
          {events.map((event) => {
            const failed = event.outcome === 'failed';
            const device = deviceLabel(event);

            return (
              <li key={event.id} className="settings-member">
                <span className="settings-avatar" aria-hidden="true">
                  {failed ? (
                    <ShieldAlert size={14} />
                  ) : (
                    <ShieldCheck size={14} />
                  )}
                </span>
                <span className="settings-member-identity">
                  <strong>{eventLabel(event)}</strong>
                  <span>
                    <WorkspaceDate value={event.createdAt} />
                  </span>
                  {failed ? <span>{failureReason(event.reason)}</span> : null}
                  {device ? <span>{device}</span> : null}
                </span>
                {failed ? (
                  <Badge tone="danger">
                    {m.settings_security_activity_failed_badge()}
                  </Badge>
                ) : event.currentSession ? (
                  <Badge tone="info">
                    {m.settings_security_activity_this_session()}
                  </Badge>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="settings-note settings-security-row">
          {m.settings_security_activity_empty()}
        </p>
      )}
      {activity.isError && events.length ? (
        <div className="settings-security-row">
          <Alert tone="danger" role="alert">
            {m.settings_security_activity_more_failed()}
          </Alert>
        </div>
      ) : null}
      {activity.hasNextPage ? (
        <div className="settings-security-row">
          <Button
            variant="outline"
            onClick={() => void activity.fetchNextPage()}
            disabled={activity.isFetchingNextPage}
          >
            {activity.isFetchingNextPage
              ? m.settings_security_activity_loading_more()
              : m.settings_security_activity_more()}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
