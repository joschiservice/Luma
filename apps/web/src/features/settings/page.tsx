import type { SettingsSnapshot } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Switch } from '@luma/ui/components/primitives/switch';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  Bell,
  Building2,
  Check,
  Globe2,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useId, useState } from 'react';

import { Failure } from '../identity/common';
import { contextOptions, IdentityError } from '../identity/data';
import {
  CommandFeedback,
  useSettingsCommand,
  useSettingsOnline,
} from './command';
import { settingsApi, settingsOptions, settingsResult } from './data';
import { TeamSettings } from './team';

export const settingsSections = [
  { id: 'workspace', label: 'Workspace', Icon: Building2 },
  { id: 'team', label: 'Team', Icon: Users },
  { id: 'notifications', label: 'Notifications', Icon: Bell },
  { id: 'approvals', label: 'Approvals', Icon: ShieldCheck },
] as const;

export type SettingsSection = (typeof settingsSections)[number]['id'];

/** Loads settings within the active workspace and clears protected content on access loss. */
export function SettingsPage({ section }: { section: SettingsSection }) {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const query = useQuery(settingsOptions(organizationId));
  const access = useQuery(contextOptions(organizationId));
  const error = access.error ?? query.error;
  if (error instanceof IdentityError && [401, 403, 404].includes(error.status))
    return <Failure error={error} retry={() => void query.refetch()} />;

  return (
    <SettingsView
      section={section}
      organizationId={organizationId}
      data={query.data}
      role={access.data?.actor.role ?? 'member'}
      actorId={access.data?.actor.id ?? ''}
      loading={query.isPending}
      error={
        error
          ? 'Settings could not be refreshed. Check your connection and retry.'
          : undefined
      }
      retry={() => void query.refetch()}
    />
  );
}

/** Presents linked workspace sections with shared loading, recovery and responsive navigation. */
export function SettingsView({
  section,
  organizationId,
  data,
  role,
  actorId,
  loading,
  error,
  retry,
}: {
  section: SettingsSection;
  organizationId: string;
  data?: SettingsSnapshot | undefined;
  role: 'owner' | 'admin' | 'member';
  actorId: string;
  loading?: boolean | undefined;
  error?: string | undefined;
  retry: () => void;
}) {
  const online = useSettingsOnline();
  const admin = role !== 'member';

  return (
    <div className="settings-page">
      <header className="settings-heading">
        <div>
          <span className="settings-eyebrow">YOUR WORKSPACE</span>
          <h1>Settings</h1>
          <p>Manage your workspace, people, and preferences.</p>
        </div>
        <Badge>
          <Globe2 size={13} /> {data?.workspace.dataRegion ?? 'Workspace'}
        </Badge>
      </header>
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Settings sections">
          {settingsSections.map(({ id, label, Icon }) => (
            <Link
              key={id}
              to="/app/$organizationId/settings/$section"
              params={{ organizationId, section: id }}
              aria-current={section === id ? 'page' : undefined}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
              {id === 'notifications' ? <small>You</small> : null}
            </Link>
          ))}
          <p>
            Changes apply to this workspace.
            <br />
            Email preferences are just for you.
          </p>
        </nav>
        <div className="settings-content">
          {!online ? (
            <Alert tone="warning" role="status">
              You are offline. Reconnect before saving changes.
            </Alert>
          ) : null}
          {error ? (
            <Alert tone="danger" role="alert">
              {error}{' '}
              <Button variant="outline" onClick={retry}>
                Retry
              </Button>
            </Alert>
          ) : null}
          {loading && !data ? (
            <div className="settings-loading" role="status">
              <div />
              <div />
              <div />
              Loading settings…
            </div>
          ) : null}
          {data ? (
            <>
              {!admin && section !== 'notifications' ? (
                <Alert tone="neutral">
                  <LockKeyhole size={14} /> You have member access. An owner or
                  admin can change workspace settings.
                </Alert>
              ) : null}
              {section === 'workspace' ? (
                <WorkspaceForm
                  key={`${organizationId}:workspace`}
                  data={data}
                  organizationId={organizationId}
                  disabled={!admin || !online}
                />
              ) : null}
              {section === 'notifications' ? (
                <NotificationsForm
                  key={`${organizationId}:notifications`}
                  data={data}
                  organizationId={organizationId}
                  disabled={!online}
                />
              ) : null}
              {section === 'approvals' ? (
                <ApprovalsForm
                  key={`${organizationId}:approvals`}
                  data={data}
                  organizationId={organizationId}
                  disabled={!admin || !online}
                />
              ) : null}
              {section === 'team' ? (
                <TeamSettings
                  organizationId={organizationId}
                  actorId={actorId}
                  role={role}
                  deliveryAvailable={data.deliveryAvailable}
                />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function WorkspaceForm({
  data,
  organizationId,
  disabled,
}: {
  data: SettingsSnapshot;
  organizationId: string;
  disabled: boolean;
}) {
  const current = data.workspace;
  const [draft, setDraft] = useState<{
    name: string;
    timezone: string;
    revision: number;
  } | null>(null);
  const value = draft ?? current;
  const command = useSettingsCommand(organizationId);
  const zones = Array.from(
    new Set(['UTC', current.timezone, ...Intl.supportedValuesOf('timeZone')]),
  ).map((value) => ({ value, label: value.replaceAll('_', ' ') }));

  return (
    <section>
      <SectionHeading
        title="Workspace"
        description="The details your team shares."
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const input = {
            name: value.name,
            timezone: value.timezone,
            revision: value.revision,
          };
          void command.run(async (commandId) => {
            settingsResult(
              await settingsApi.settings.updateWorkspace({
                params: { organizationId },
                body: { ...input, commandId },
              }),
            );
            setDraft(null);
          });
        }}
      >
        <div className="settings-panel">
          <div className="settings-field">
            <label htmlFor="workspace-name">Workspace name</label>
            <p>Shown in navigation and the workspace switcher.</p>
            <Input
              id="workspace-name"
              value={value.name}
              maxLength={200}
              required
              disabled={disabled || command.locked}
              onChange={(event) =>
                setDraft({ ...value, name: event.target.value })
              }
            />
          </div>
          <div className="settings-field">
            <label id="timezone-label">Display timezone</label>
            <p>Dates throughout this workspace use this timezone.</p>
            <Select
              aria-labelledby="timezone-label"
              options={zones}
              value={value.timezone}
              disabled={disabled || command.locked}
              onValueChange={(timezone) => {
                if (timezone) setDraft({ ...value, timezone });
              }}
            />
          </div>
          <div className="settings-readonly">
            <div>
              <span>Workspace slug</span>
              <code>{current.slug}</code>
            </div>
            <div>
              <span>Data region</span>
              <strong>
                {current.dataRegion === 'EU'
                  ? 'European Union'
                  : current.dataRegion}
              </strong>
            </div>
            <LockKeyhole size={15} aria-label="Read-only" />
          </div>
        </div>
        <SaveBar
          reset={draft && !command.locked ? () => setDraft(null) : undefined}
          disabled={
            disabled ||
            command.locked ||
            !value.name.trim() ||
            (value.name === current.name && value.timezone === current.timezone)
          }
          pending={command.pending}
        />
        <CommandFeedback command={command} />
      </form>
    </section>
  );
}

function NotificationsForm({
  data,
  organizationId,
  disabled,
}: {
  data: SettingsSnapshot;
  organizationId: string;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<SettingsSnapshot['preferences'] | null>(
    null,
  );
  const value = draft ?? data.preferences;
  const command = useSettingsCommand(organizationId);
  const test = useSettingsCommand(organizationId);

  return (
    <section>
      <SectionHeading
        title="Notifications"
        description="Choose what reaches your inbox. These preferences are only yours."
        badge="Personal"
      />
      {!data.deliveryAvailable ? (
        <Alert tone="warning">
          <strong>Email delivery unavailable</strong>
          <p>
            Your choices are saved, but email cannot be sent until an
            administrator configures delivery.
          </p>
        </Alert>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void command.run(async (commandId) => {
            settingsResult(
              await settingsApi.settings.updateNotifications({
                params: { organizationId },
                body: { ...value, commandId },
              }),
            );
            setDraft(null);
          });
        }}
      >
        <div className="settings-panel">
          <PreferenceRow
            title="Issues that need you"
            description="An issue needs approval, manual intervention, or a review of uncertain evidence."
            checked={value.issues}
            disabled={disabled || command.locked}
            change={(issues) => setDraft({ ...value, issues })}
          />
          <PreferenceRow
            title="Connection health"
            description="A connected system is degraded or its access has been revoked."
            checked={value.connections}
            disabled={disabled || command.locked}
            change={(connections) => setDraft({ ...value, connections })}
          />
        </div>
        <p className="settings-note">
          <Check size={14} /> Issues → Needs you and Overview always show work
          requiring attention.
        </p>
        <SaveBar
          reset={draft && !command.locked ? () => setDraft(null) : undefined}
          pending={command.pending}
          disabled={
            disabled ||
            command.locked ||
            (value.issues === data.preferences.issues &&
              value.connections === data.preferences.connections)
          }
        />
        <CommandFeedback command={command} />
      </form>
      <div className="settings-test">
        <Mail size={18} />
        <div>
          <strong>Check your inbox connection</strong>
          <p>Send a test email to your signed-in account.</p>
          {data.lastTest ? (
            <span role="status">
              {data.lastTest.state === 'sent'
                ? 'Test email accepted for delivery.'
                : data.lastTest.state === 'failed'
                  ? 'Delivery failed. Check email configuration and try again.'
                  : data.lastTest.state === 'queued'
                    ? 'Test email queued. Waiting for delivery…'
                    : 'Test email cancelled.'}
            </span>
          ) : null}
        </div>
        <Button
          variant="outline"
          disabled={
            disabled ||
            !data.deliveryAvailable ||
            test.locked ||
            data.lastTest?.state === 'queued'
          }
          onClick={() =>
            void test.run(
              async (commandId) =>
                settingsResult(
                  await settingsApi.settings.testEmail({
                    params: { organizationId },
                    body: { commandId },
                  }),
                ),
              'Test email queued.',
            )
          }
        >
          Send test email
        </Button>
      </div>
      <CommandFeedback command={test} />
    </section>
  );
}

function ApprovalsForm({
  data,
  organizationId,
  disabled,
}: {
  data: SettingsSnapshot;
  organizationId: string;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<{
    required: boolean;
    revision: number;
  } | null>(null);
  const required = draft?.required ?? data.workspace.alwaysRequireApproval;
  const command = useSettingsCommand(organizationId);

  return (
    <section>
      <SectionHeading
        title="Approvals"
        description="Set the level of human review for your workspace."
      />
      <div className="settings-policy">
        <ShieldCheck size={22} />
        <div>
          <strong>
            {data.workspace.alwaysRequireApproval
              ? 'Independent approval for every permitted change'
              : 'Platform approval policy'}
          </strong>
          <p>
            {data.workspace.alwaysRequireApproval
              ? 'Every otherwise permitted change needs review by another owner or admin.'
              : 'Low-risk permitted changes can proceed. Higher-risk changes require independent approval.'}
          </p>
          <span>
            Policy revision {data.workspace.policyRevision} · Owners and admins
            can approve
          </span>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void command.run(async (commandId) => {
            settingsResult(
              await settingsApi.settings.updateApprovals({
                params: { organizationId },
                body: {
                  commandId,
                  revision: draft?.revision ?? data.workspace.policyRevision,
                  alwaysRequireApproval: required,
                },
              }),
            );
            setDraft(null);
          }, 'Approval preference saved. Older reviews must be refreshed.');
        }}
      >
        <div className="settings-panel">
          <PreferenceRow
            title="Always require approval"
            description="Require a different owner or admin to approve otherwise permitted changes."
            checked={required}
            disabled={disabled || command.locked}
            change={(value) =>
              setDraft({
                required: value,
                revision: draft?.revision ?? data.workspace.policyRevision,
              })
            }
          />
        </div>
        <div className="settings-guardrails">
          <h3>Always enforced</h3>
          <p>
            <Check size={14} /> Platform-required approvals and denied actions
          </p>
          <p>
            <Check size={14} /> Current capability grants and execution checks
          </p>
          <p>
            <Check size={14} /> Independent approval and outcome verification
          </p>
        </div>
        <p className="settings-note">
          Turning this off restores platform policy. Saved changes require fresh
          policy review before execution.
        </p>
        <SaveBar
          reset={draft && !command.locked ? () => setDraft(null) : undefined}
          disabled={
            disabled ||
            command.locked ||
            required === data.workspace.alwaysRequireApproval
          }
          pending={command.pending}
        />
        <CommandFeedback command={command} />
      </form>
    </section>
  );
}

/** Provides consistent headings for Settings sections. */
export function SectionHeading({
  title,
  description,
  badge,
}: {
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <header className="settings-section-heading">
      <div>
        <h2>
          {title} {badge ? <Badge>{badge}</Badge> : null}
        </h2>
        <p>{description}</p>
      </div>
    </header>
  );
}

function PreferenceRow({
  title,
  description,
  checked,
  disabled,
  change,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  change: (value: boolean) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <div className="settings-preference">
      <span>
        <strong id={titleId}>{title}</strong>
        <span id={descriptionId}>{description}</span>
      </span>
      <Switch
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={change}
      />
    </div>
  );
}

function SaveBar({
  disabled,
  pending,
  reset,
}: {
  disabled: boolean;
  pending: boolean;
  reset?: (() => void) | undefined;
}) {
  return (
    <div className="settings-save">
      {reset ? (
        <Button type="button" variant="ghost" onClick={reset}>
          Cancel changes
        </Button>
      ) : null}
      <Button type="submit" disabled={disabled}>
        {pending ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  );
}
