import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { createWebApiClient } from '../../lib/api-client';
import { IdentityError } from '../../lib/api-error';
import { privateQueryDefaults } from '../../lib/private-query';
import { securityActivityKey } from './security-activity';
import { SupportInspectionList } from './support-inspections';

const api = createWebApiClient();

const accountInspectionsKey = [
  'private',
  'account-support-inspections',
] as const;

/** Reads Luma support requests for the signed-in person's own account. */
const accountInspectionsOptions = () =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: accountInspectionsKey,
    queryFn: ({ signal }) =>
      api.identity.listSupportInspections(undefined, { signal }),
  });

/**
 * Lets the signed-in person approve, decline or end Luma support access to their own account.
 * Each answer refreshes the list and the security activity that records it.
 */
export function AccountSupportAccess({ disabled }: { disabled: boolean }) {
  const client = useQueryClient();
  const inspections = useQuery(accountInspectionsOptions());
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function change(
    operation: () => Promise<{ items: unknown[] }>,
    success: string,
  ) {
    if (pending) return;
    setPending(true);
    setNotice('');
    setError('');
    try {
      await operation();
      setNotice(success);
    } catch (failure) {
      setError(
        failure instanceof IdentityError && failure.status < 500
          ? failure.message
          : m.settings_security_support_action_failed(),
      );
    } finally {
      await Promise.all([
        client.invalidateQueries({ queryKey: accountInspectionsKey }),
        client.invalidateQueries({ queryKey: securityActivityKey }),
      ]);
      setPending(false);
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <div>
          <h3>{m.settings_security_support_title()}</h3>
          <p>{m.settings_security_support_description()}</p>
        </div>
      </div>
      {inspections.isPending ? (
        <p className="settings-note settings-security-row" role="status">
          {m.settings_security_support_loading()}
        </p>
      ) : inspections.isError ? (
        <div className="settings-security-row">
          <Alert tone="danger" role="alert">
            {m.settings_security_support_failed()}{' '}
            <Button
              variant="outline"
              onClick={() => void inspections.refetch()}
            >
              {m.common_retry()}
            </Button>
          </Alert>
        </div>
      ) : inspections.data.items.length ? (
        <SupportInspectionList
          items={inspections.data.items}
          locked={disabled || pending}
          onDecide={(requestId, decision) =>
            void change(
              () =>
                api.identity.decideSupportInspection({
                  params: { requestId },
                  body: { decision },
                }),
              decision === 'approve'
                ? m.settings_security_support_approved()
                : m.settings_security_support_declined(),
            )
          }
          onRevoke={(requestId) =>
            void change(
              () =>
                api.identity.revokeSupportInspection({ params: { requestId } }),
              m.settings_security_support_ended(),
            )
          }
        />
      ) : (
        <p className="settings-note settings-security-row">
          {m.settings_security_support_empty()}
        </p>
      )}
      <div
        className="settings-feedback settings-security-row"
        aria-live="polite"
      >
        {notice ? (
          <span className="settings-saved" role="status">
            {notice}
          </span>
        ) : null}
        {error ? (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
