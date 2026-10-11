import type { SupportAccess } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Check, LifeBuoy } from 'lucide-react';
import { useId, useState } from 'react';

import { settingsApi } from '../../kit/settings/data';
import { privateQueryDefaults } from '../../lib/private-query';
import { CommandFeedback, useSettingsCommand } from './command';
import { SectionHeading } from './section-heading';

const durations = [
  { hours: 24, label: m.settings_support_duration_day },
  { hours: 72, label: m.settings_support_duration_three_days },
  { hours: 168, label: m.settings_support_duration_week },
] as const;

type Duration = (typeof durations)[number]['hours'];

const durationLabel = (hours: Duration) =>
  durations.find((item) => item.hours === hours)?.label() ?? '';

/** Loads until when Luma support may view the workspace, and pending requests. */
const supportAccessOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'support-access'],
    queryFn: ({ signal }) =>
      settingsApi.settings.supportAccess(
        { params: { organizationId } },
        { signal },
      ),
  });

/**
 * Lets people with `support_access.manage` allow read-only Luma support access for a chosen
 * period, revoke it, and answer requests from Luma support.
 */
export function SupportAccessSettings({
  organizationId,
  disabled,
}: {
  organizationId: string;
  disabled: boolean;
}) {
  const query = useQuery(supportAccessOptions(organizationId));

  return (
    <section>
      <SectionHeading
        title={m.settings_support_title()}
        description={m.settings_support_description()}
      />
      {query.error ? (
        <Alert tone="danger" role="alert">
          {m.settings_support_load_failed()}{' '}
          <Button variant="outline" onClick={() => void query.refetch()}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {query.isPending ? (
        <p role="status">{m.settings_support_loading()}</p>
      ) : null}
      {query.data ? (
        <SupportAccessForm
          key={query.data.revision}
          organizationId={organizationId}
          access={query.data}
          disabled={disabled}
        />
      ) : null}
    </section>
  );
}

function SupportAccessForm({
  organizationId,
  access,
  disabled,
}: {
  organizationId: string;
  access: SupportAccess;
  disabled: boolean;
}) {
  const command = useSettingsCommand(organizationId);
  const [duration, setDuration] = useState<Duration>(24);
  const durationId = useId();
  const locked = disabled || command.locked;

  return (
    <>
      <div className="settings-policy">
        <LifeBuoy size={22} aria-hidden="true" />
        <div>
          <strong>
            {access.allowedUntil
              ? m.settings_support_allowed_title()
              : m.settings_support_off_title()}
          </strong>
          <p>
            {access.allowedUntil ? (
              <>
                {m.settings_support_allowed_until()}{' '}
                <WorkspaceDate value={access.allowedUntil} />
              </>
            ) : (
              m.settings_support_off_body()
            )}
          </p>
        </div>
      </div>
      <div className="settings-panel">
        <div className="settings-support-allow">
          <label id={durationId}>{m.settings_support_duration_label()}</label>
          <Select
            aria-labelledby={durationId}
            options={durations.map((item) => ({
              value: String(item.hours),
              label: item.label(),
            }))}
            value={String(duration)}
            disabled={locked}
            onValueChange={(value) => {
              const choice = durations.find(
                (item) => String(item.hours) === value,
              );
              if (choice) setDuration(choice.hours);
            }}
          />
          <Button
            disabled={locked}
            onClick={() =>
              void command.run(
                (commandId) =>
                  settingsApi.settings.allowSupportAccess({
                    params: { organizationId },
                    body: {
                      commandId,
                      revision: access.revision,
                      durationHours: duration,
                    },
                  }),
                m.settings_support_allowed_saved(),
              )
            }
          >
            {access.allowedUntil
              ? m.settings_support_extend()
              : m.settings_support_allow()}
          </Button>
          {access.allowedUntil ? (
            <Button
              variant="outline"
              disabled={locked}
              onClick={() =>
                void command.run(
                  (commandId) =>
                    settingsApi.settings.revokeSupportAccess({
                      params: { organizationId },
                      body: { commandId, revision: access.revision },
                    }),
                  m.settings_support_revoked_saved(),
                )
              }
            >
              {m.settings_support_revoke()}
            </Button>
          ) : null}
        </div>
      </div>
      {access.requests.length ? (
        <div className="settings-panel">
          <div className="settings-panel-heading">
            <h3>{m.settings_support_requests_title()}</h3>
            <p>{m.settings_support_requests_description()}</p>
          </div>
          {access.requests.map((request) => (
            <div key={request.id} className="settings-support-request">
              <div>
                <strong>
                  {m.settings_support_request_summary({
                    duration: durationLabel(request.durationHours),
                  })}
                </strong>
                <p>{request.reason}</p>
                <span>
                  {m.settings_support_request_asked()}{' '}
                  <WorkspaceDate value={request.requestedAt} />
                  {' · '}
                  {m.settings_support_request_lapses()}{' '}
                  <WorkspaceDate value={request.expiresAt} />
                </span>
              </div>
              <div className="settings-support-request-actions">
                <Button
                  disabled={locked}
                  onClick={() =>
                    void command.run(
                      (commandId) =>
                        settingsApi.settings.decideSupportAccessRequest({
                          params: { organizationId, requestId: request.id },
                          body: { commandId, decision: 'approve' },
                        }),
                      m.settings_support_request_approved(),
                    )
                  }
                >
                  {m.settings_support_request_approve()}
                </Button>
                <Button
                  variant="outline"
                  disabled={locked}
                  onClick={() =>
                    void command.run(
                      (commandId) =>
                        settingsApi.settings.decideSupportAccessRequest({
                          params: { organizationId, requestId: request.id },
                          body: { commandId, decision: 'decline' },
                        }),
                      m.settings_support_request_declined(),
                    )
                  }
                >
                  {m.settings_support_request_decline()}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="settings-guardrails">
        <h3>{m.settings_support_guardrails_title()}</h3>
        <p>
          <Check size={14} aria-hidden="true" />{' '}
          {m.settings_support_guardrail_read_only()}
        </p>
        <p>
          <Check size={14} aria-hidden="true" />{' '}
          {m.settings_support_guardrail_activity()}
        </p>
        <p>
          <Check size={14} aria-hidden="true" />{' '}
          {m.settings_support_guardrail_limits()}
        </p>
      </div>
      <p className="settings-note">{m.settings_support_emergency_note()}</p>
      <CommandFeedback command={command} />
    </>
  );
}
