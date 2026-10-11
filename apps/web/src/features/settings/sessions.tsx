import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';

import { auth, clearPrivate, IdentityError } from '../../kit/identity/data';
import { privateQueryDefaults } from '../../lib/private-query';
import { securityActivityKey } from './security-activity';

export const accountSessionsKey = ['private', 'account-sessions'] as const;
const sessionsSchema = z.array(
  z.object({
    id: z.string(),
    token: z.string(),
    current: z.boolean(),
    lastActiveAt: z.union([
      z.iso.datetime(),
      z.date().transform((value) => value.toISOString()),
    ]),
    ipAddress: z.string().nullable(),
    browser: z.string().nullable(),
    os: z.string().nullable(),
  }),
);

type AccountSession = z.infer<typeof sessionsSchema>[number];

/** Reads active account sessions; failed or malformed responses never appear as an empty list. */
const accountSessionsOptions = () =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: accountSessionsKey,
    queryFn: async ({ signal }) => {
      const result = await auth.listSessions({
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.error)
        throw new IdentityError(result.error.status, result.error);

      return sessionsSchema.parse(result.data);
    },
  });

/** Shows active devices and signs out one device or every other device after confirmation. */
export function SessionSettings({ disabled }: { disabled: boolean }) {
  const sessions = useQuery(accountSessionsOptions());
  const client = useQueryClient();
  const [target, setTarget] = useState<AccountSession | 'others' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function revoke() {
    if (!target || pending) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const result =
        target === 'others'
          ? await auth.revokeOtherSessions()
          : await auth.revokeSession({ token: target.token });
      if (result.error) {
        setError(m.settings_security_sessions_revoke_failed());

        return;
      }
      if (target !== 'others' && target.current) {
        await clearPrivate(client);
        window.location.assign('/sign-in');

        return;
      }
      setTarget(null);
      setNotice(m.settings_security_sessions_revoked());
      await Promise.all(
        [accountSessionsKey, securityActivityKey].map((queryKey) =>
          client.invalidateQueries({ queryKey }),
        ),
      );
    } catch {
      setError(m.settings_security_unreachable());
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <div>
          <h3>{m.settings_security_sessions_title()}</h3>
          <p>{m.settings_security_sessions_description()}</p>
        </div>
      </div>
      {sessions.isPending ? (
        <p className="settings-note settings-security-row" role="status">
          {m.settings_security_sessions_loading()}
        </p>
      ) : null}
      {sessions.isError ? (
        <div className="settings-security-row">
          <Alert tone="danger" role="alert">
            {m.settings_security_sessions_failed()}{' '}
            <Button variant="outline" onClick={() => void sessions.refetch()}>
              {m.common_retry()}
            </Button>
          </Alert>
        </div>
      ) : null}
      {sessions.data ? (
        <ul
          className="settings-passkeys"
          aria-label={m.settings_security_sessions_title()}
        >
          {sessions.data.map((session) => (
            <li key={session.id} className="settings-member">
              <span className="settings-member-identity">
                <strong>
                  {[session.browser, session.os].filter(Boolean).join(' · ') ||
                    m.settings_security_activity_device_unknown()}
                </strong>
                <span>
                  {session.ipAddress ||
                    m.settings_security_sessions_location_unknown()}
                </span>
                <span>
                  {m.settings_security_sessions_last_active()}{' '}
                  <WorkspaceDate value={session.lastActiveAt} />
                </span>
              </span>
              {session.current ? (
                <Badge>{m.settings_security_sessions_current()}</Badge>
              ) : null}
              <Button
                variant="outline"
                disabled={disabled || sessions.isError}
                onClick={() => {
                  setError('');
                  setTarget(session);
                }}
              >
                {m.settings_security_sessions_sign_out()}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="settings-security-row">
        <Button
          variant="outline"
          disabled={
            disabled ||
            !sessions.data?.some((session) => !session.current) ||
            sessions.isError
          }
          onClick={() => {
            setError('');
            setTarget('others');
          }}
        >
          {m.settings_security_sessions_others()}
        </Button>
      </div>
      {notice ? (
        <p className="settings-note settings-security-row" role="status">
          {notice}
        </p>
      ) : null}
      {target ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next && !pending) setTarget(null);
          }}
        >
          <DialogContent>
            <DialogTitle>
              {target === 'others'
                ? m.settings_security_sessions_others()
                : m.settings_security_sessions_sign_out()}
            </DialogTitle>
            <DialogDescription>
              {m.settings_security_sessions_confirm()}
            </DialogDescription>
            {error ? (
              <Alert tone="danger" role="alert">
                {error}
              </Alert>
            ) : null}
            <div className="settings-dialog-actions">
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => setTarget(null)}
              >
                {m.common_cancel()}
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => void revoke()}
              >
                {m.settings_security_sessions_sign_out()}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
