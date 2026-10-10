import './settings.css';

import type { SettingsSnapshot } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { SearchableSelect } from '@luma/ui/components/primitives/searchable-select';
import { SectionNavigation } from '@luma/ui/components/primitives/section-navigation';
import { Switch } from '@luma/ui/components/primitives/switch';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  Bell,
  Building2,
  Check,
  IdCard,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  LockKeyhole,
  Mail,
  Palette,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useId, useState } from 'react';

import { Failure } from '../identity/common';
import { contextOptions, IdentityError } from '../identity/data';
import { usePermissionLabel, usePermissions } from '../identity/permissions';
import {
  CommandFeedback,
  useSettingsCommand,
  useSettingsOnline,
} from './command';
import { settingsApi, settingsOptions } from './data';
import { AppearanceSettings, HomeSidebarSettings } from './personal';
import { RolesSettings } from './roles';
import { SectionHeading } from './section-heading';
import { SecuritySettings } from './security';
import { SourceAuthoritySettings } from './source-authority';
import { SupportAccessSettings } from './support-access';
import { TeamSettings } from './team';

export const settingsSections = [
  {
    id: 'workspace',
    label: m.settings_section_workspace,
    group: m.settings_group_workspace,
    Icon: Building2,
  },
  {
    id: 'authority',
    label: m.settings_section_authority,
    group: m.settings_group_workspace,
    Icon: ShieldCheck,
  },
  {
    id: 'team',
    label: m.settings_section_team,
    group: m.settings_group_workspace,
    Icon: Users,
  },
  {
    id: 'roles',
    label: m.settings_section_roles,
    group: m.settings_group_workspace,
    Icon: IdCard,
  },
  {
    id: 'approvals',
    label: m.settings_section_approvals,
    group: m.settings_group_workspace,
    Icon: ShieldCheck,
  },
  {
    id: 'support',
    label: m.settings_section_support,
    group: m.settings_group_workspace,
    Icon: LifeBuoy,
  },
  {
    id: 'security',
    label: m.settings_section_security,
    group: m.settings_group_personal,
    Icon: KeyRound,
  },
  {
    id: 'notifications',
    label: m.settings_section_notifications,
    group: m.settings_group_personal,
    Icon: Bell,
  },
  {
    id: 'appearance',
    label: m.settings_section_appearance,
    group: m.settings_group_personal,
    Icon: Palette,
  },
  {
    id: 'home',
    label: m.settings_section_home,
    group: m.settings_group_personal,
    Icon: LayoutDashboard,
  },
] as const;

export type SettingsSection = (typeof settingsSections)[number]['id'];

/** Loads settings within the active workspace and clears protected content on access loss. */
export function SettingsPage({
  section,
  roleId,
}: {
  section: SettingsSection;
  /** The role open in Roles, if any. */
  roleId?: string | undefined;
}) {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const query = useQuery(settingsOptions(organizationId));
  const access = useQuery(contextOptions(organizationId));
  const permissions = usePermissions(organizationId);
  const supportView = !!access.data?.supportView;
  const error = access.error ?? query.error;
  if (error instanceof IdentityError && [401, 403, 404].includes(error.status))
    return <Failure error={error} retry={() => void query.refetch()} />;

  return (
    <SettingsView
      section={section}
      roleId={roleId}
      organizationId={organizationId}
      data={query.data}
      can={permissions.can}
      actorId={access.data?.actor.id ?? ''}
      supportView={supportView}
      loading={query.isPending}
      error={error ? m.settings_load_failed() : undefined}
      retry={() => void query.refetch()}
    />
  );
}

/** Presents linked workspace sections with shared loading, recovery and responsive navigation. */
export function SettingsView({
  section,
  roleId,
  organizationId,
  data,
  can,
  actorId,
  supportView = false,
  loading,
  error,
  retry,
}: {
  section: SettingsSection;
  roleId?: string | undefined;
  organizationId: string;
  data?: SettingsSnapshot | undefined;
  /** Whether the signed-in person holds a permission. */
  can: (permission: string) => boolean;
  actorId: string;
  /** In a Luma support view, personal security settings aren't offered. */
  supportView?: boolean | undefined;
  loading?: boolean | undefined;
  error?: string | undefined;
  retry: () => void;
}) {
  const online = useSettingsOnline();
  const required =
    section === 'workspace' || section === 'authority'
      ? 'workspace.settings.manage'
      : section === 'approvals'
        ? 'workspace.approval_policy.manage'
        : section === 'support'
          ? 'support_access.manage'
          : null;

  return (
    <div className="settings-page">
      <PageTitle title={m.settings_page_title()} />
      <div className="settings-layout">
        <SectionNavigation
          className="settings-navigation"
          aria-label={m.settings_navigation_label()}
          items={settingsSections
            .filter(({ id }) => !(supportView && id === 'security'))
            .map(({ id, label, group, Icon }) => ({
              value: id,
              label: label(),
              group: group(),
              icon: <Icon size={16} />,
            }))}
          value={section}
          renderItem={(item, className) => (
            <Link
              className={className}
              to="/app/$organizationId/settings/$section"
              params={{
                organizationId,
                section: item.value as SettingsSection,
              }}
              aria-current={section === item.value ? 'page' : undefined}
            >
              <span className="section-navigation-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </Link>
          )}
        />
        <div className="settings-content">
          {!online ? (
            <Alert tone="warning" role="status">
              {m.common_offline_save()}
            </Alert>
          ) : null}
          {error ? (
            <Alert tone="danger" role="alert">
              {error}{' '}
              <Button variant="outline" onClick={retry}>
                {m.common_retry()}
              </Button>
            </Alert>
          ) : null}
          {loading && !data ? (
            <div className="settings-loading" role="status">
              <div />
              <div />
              <div />
              {m.settings_loading()}
            </div>
          ) : null}
          {data ? (
            <>
              {required && !can(required) ? (
                <ReadOnlyNotice
                  organizationId={organizationId}
                  permission={required}
                />
              ) : null}
              {section === 'workspace' ? (
                <WorkspaceForm
                  key={`${organizationId}:workspace`}
                  data={data}
                  organizationId={organizationId}
                  disabled={!can('workspace.settings.manage') || !online}
                />
              ) : null}
              {section === 'authority' ? (
                <SourceAuthoritySettings
                  key={organizationId}
                  organizationId={organizationId}
                  disabled={
                    !can('workspace.settings.manage') || !online || supportView
                  }
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
                  disabled={!can('workspace.approval_policy.manage') || !online}
                />
              ) : null}
              {section === 'security' && supportView ? (
                <Alert tone="neutral">
                  {m.settings_security_support_view()}
                </Alert>
              ) : null}
              {section === 'security' && !supportView ? (
                <SecuritySettings disabled={!online} />
              ) : null}
              {section === 'support' && can('support_access.manage') ? (
                <SupportAccessSettings
                  key={`${organizationId}:support`}
                  organizationId={organizationId}
                  disabled={!online}
                />
              ) : null}
              {section === 'appearance' ? <AppearanceSettings /> : null}
              {section === 'home' ? (
                <HomeSidebarSettings organizationId={organizationId} />
              ) : null}
              {section === 'team' ? (
                <TeamSettings
                  organizationId={organizationId}
                  actorId={actorId}
                  deliveryAvailable={data.deliveryAvailable}
                />
              ) : null}
              {section === 'roles' ? (
                <RolesSettings
                  organizationId={organizationId}
                  roleId={roleId}
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
        title={m.settings_workspace_title()}
        description={m.settings_workspace_description()}
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
            await settingsApi.settings.updateWorkspace({
              params: { organizationId },
              body: { ...input, commandId },
            });
            setDraft(null);
          });
        }}
      >
        <div className="settings-panel">
          <div className="settings-field">
            <label htmlFor="workspace-name">
              {m.settings_workspace_name_label()}
            </label>
            <p>{m.settings_workspace_name_help()}</p>
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
            <label id="timezone-label">
              {m.settings_workspace_timezone_label()}
            </label>
            <p>{m.settings_workspace_timezone_help()}</p>
            <SearchableSelect
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
              <span>{m.settings_workspace_identifier_label()}</span>
              <code>{current.slug}</code>
            </div>
            <div>
              <span>{m.settings_workspace_region_label()}</span>
              <strong>
                {current.dataRegion === 'EU'
                  ? m.settings_workspace_region_eu()
                  : current.dataRegion}
              </strong>
            </div>
            <LockKeyhole
              size={15}
              aria-label={m.settings_workspace_read_only()}
            />
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

const testEmailStates = {
  sent: m.settings_notifications_test_sent,
  failed: m.settings_notifications_test_failed,
  queued: m.settings_notifications_test_queued,
  cancelled: m.settings_notifications_test_canceled,
} satisfies Record<
  NonNullable<SettingsSnapshot['lastTest']>['state'],
  () => string
>;

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
        title={m.settings_notifications_title()}
        description={m.settings_notifications_description()}
        badge={m.settings_badge_personal()}
      />
      {!data.deliveryAvailable ? (
        <Alert tone="warning">
          <strong>{m.settings_notifications_unavailable_title()}</strong>
          <p>{m.settings_notifications_unavailable_body()}</p>
        </Alert>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void command.run(async (commandId) => {
            await settingsApi.settings.updateNotifications({
              params: { organizationId },
              body: { ...value, commandId },
            });
            setDraft(null);
          });
        }}
      >
        <div className="settings-panel">
          <PreferenceRow
            title={m.settings_notifications_issues_title()}
            description={m.settings_notifications_issues_description()}
            checked={value.issues}
            disabled={disabled || command.locked}
            change={(issues) => setDraft({ ...value, issues })}
          />
          <PreferenceRow
            title={m.settings_notifications_connections_title()}
            description={m.settings_notifications_connections_description()}
            checked={value.connections}
            disabled={disabled || command.locked}
            change={(connections) => setDraft({ ...value, connections })}
          />
        </div>
        <p className="settings-note">
          <Check size={14} aria-hidden="true" />{' '}
          {m.settings_notifications_always_shown()}
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
          <strong>{m.settings_notifications_test_title()}</strong>
          <p>{m.settings_notifications_test_description()}</p>
          {data.lastTest ? (
            <span role="status">{testEmailStates[data.lastTest.state]()}</span>
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
              (commandId) =>
                settingsApi.settings.testEmail({
                  params: { organizationId },
                  body: { commandId },
                }),
              m.settings_notifications_test_queued_notice(),
            )
          }
        >
          {m.settings_notifications_test_send()}
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
  const approverPermission = usePermissionLabel(
    organizationId,
    'decisions.respond',
  );

  return (
    <section>
      <SectionHeading
        title={m.settings_approvals_title()}
        description={m.settings_approvals_description()}
      />
      <div className="settings-policy">
        <ShieldCheck size={22} />
        <div>
          <strong>
            {data.workspace.alwaysRequireApproval
              ? m.settings_approvals_always_summary_title()
              : m.settings_approvals_standard_summary_title()}
          </strong>
          <p>
            {data.workspace.alwaysRequireApproval
              ? m.settings_approvals_always_summary_body()
              : m.settings_approvals_standard_summary_body()}
          </p>
          <span>
            {rich(m.settings_approvals_approvers, {
              permission: <strong>{approverPermission}</strong>,
            })}
          </span>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void command.run(async (commandId) => {
            await settingsApi.settings.updateApprovals({
              params: { organizationId },
              body: {
                commandId,
                revision: draft?.revision ?? data.workspace.policyRevision,
                alwaysRequireApproval: required,
              },
            });
            setDraft(null);
          }, m.settings_approvals_saved());
        }}
      >
        <div className="settings-panel">
          <PreferenceRow
            title={m.settings_approvals_always_title()}
            description={m.settings_approvals_always_description()}
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
          <h3>{m.settings_approvals_guardrails_title()}</h3>
          <p>
            <Check size={14} aria-hidden="true" />{' '}
            {m.settings_approvals_guardrail_required()}
          </p>
          <p>
            <Check size={14} aria-hidden="true" />{' '}
            {m.settings_approvals_guardrail_permissions()}
          </p>
          <p>
            <Check size={14} aria-hidden="true" />{' '}
            {m.settings_approvals_guardrail_independent()}
          </p>
        </div>
        <p className="settings-note">{m.settings_approvals_change_note()}</p>
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

/** Explains which permission a read-only settings section needs. */
function ReadOnlyNotice({
  organizationId,
  permission,
}: {
  organizationId: string;
  permission: string;
}) {
  const label = usePermissionLabel(organizationId, permission);

  return (
    <Alert tone="neutral">
      <LockKeyhole size={14} aria-hidden="true" />{' '}
      {rich(m.settings_read_only_notice, {
        permission: <strong>{label}</strong>,
      })}
    </Alert>
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
          {m.common_discard_changes()}
        </Button>
      ) : null}
      <Button type="submit" disabled={disabled}>
        {pending ? m.common_saving() : m.common_save_changes()}
      </Button>
    </div>
  );
}
