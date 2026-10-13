import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { WorkspaceAccountMenu } from '@luma/ui/components/workspace/workspace-account-menu';
import { WorkspaceSwitcher } from '@luma/ui/components/workspace/workspace-switcher';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { useEffect } from 'react';

import {
  SupportViewBanner,
  useEndSupportView,
} from '../features/account/support-view';
import { adaptiveAvailabilityOptions } from '../features/adaptive/data';
import { AppNavigation } from '../features/apps/navigation';
import { AssistantPanel } from '../features/assistant/panel';
import {
  AssistantToggle,
  useAssistantShortcut,
} from '../features/assistant/toggle';
import { decisionsOptions } from '../features/decisions/data';
import { ContextHelp } from '../features/help/context-help';
import { RecordMessages } from '../features/inbox/record-messages';
import { Failure, Pending } from '../kit/identity/common';
import {
  contextOptions,
  organizationsOptions,
  sessionOptions,
} from '../kit/identity/data';
import { NoAccess, usePermissions } from '../kit/identity/permissions';
import {
  type RecordMessagesProps,
  RecordMessagesProvider,
} from '../kit/record-messages';
import { settingsOptions } from '../kit/settings/data';
import { useAssistantOpen } from '../lib/assistant-panel';
import { isTypingTarget } from '../lib/keyboard';
import { setThemePreference, useThemePreference } from '../lib/theme';
import { PinCurrentPage, PinnedNavigation } from './pins';
import {
  destinationFor,
  type WorkspaceDestination,
  workspaceDestinations,
} from './workspace-destinations';
import { WorkspaceLayout } from './workspace-layout';
import { WorkspaceSearch } from './workspace-search';

const appPagePattern = /^\/app\/[^/]+\/apps\/[^/]+\/?$/;

function NavigationLink({
  destination,
  organizationId,
  close,
  count,
  exact = false,
}: {
  destination: WorkspaceDestination;
  organizationId: string;
  close?: (() => void) | undefined;
  count?: number | undefined;
  exact?: boolean;
}) {
  const { path, label, Icon, domain } = destination;

  return (
    <Link
      className="sidebar-link"
      data-label={label}
      to={`/app/$organizationId/${path}`}
      params={{ organizationId }}
      activeOptions={{ exact, includeSearch: false }}
      activeProps={{ 'aria-current': 'page' }}
      onClick={close}
    >
      {domain ? (
        <DomainIcon domain={domain} size="xs" className="sidebar-link-icon" />
      ) : (
        <Icon className="sidebar-link-icon" size={16} aria-hidden="true" />
      )}
      <span className="sidebar-link-label">{label}</span>
      {count ? (
        <span className="sidebar-link-count">
          <span aria-hidden="true">{formatNumber(count)}</span>
          <span className="sr-only">
            {m.identity_nav_waiting_count({ count })}
          </span>
        </span>
      ) : null}
    </Link>
  );
}

function Navigation({
  organizationId,
  close,
}: {
  organizationId: string;
  close?: (() => void) | undefined;
}) {
  const onAppPage = useLocation({
    select: (location) => appPagePattern.test(location.pathname),
  });
  const waiting = useQuery({
    ...decisionsOptions(organizationId, {}, 1),
    select: (list) => list.counts.views.all,
  });
  const { can } = usePermissions(organizationId);
  const adaptive = useQuery(adaptiveAvailabilityOptions(organizationId));
  // Areas outside the person's role stay out of navigation; opening them explains why.
  const group = (name: WorkspaceDestination['group']) =>
    workspaceDestinations.filter(
      (item) =>
        item.group === name &&
        (item.path !== 'views' || adaptive.data?.views === true) &&
        (!item.permission || can(item.permission)),
    );
  const link = (destination: WorkspaceDestination) => (
    <li key={destination.path}>
      <NavigationLink
        destination={destination}
        organizationId={organizationId}
        close={close}
        count={destination.path === 'needs-you' ? waiting.data : undefined}
        exact={destination.path === 'apps' && onAppPage}
      />
    </li>
  );

  return (
    <nav aria-label={m.identity_nav_label()} className="sidebar-nav">
      <ul className="sidebar-list">{group('core').map(link)}</ul>
      <PinnedNavigation organizationId={organizationId} close={close} />
      <section className="sidebar-section" aria-labelledby="nav-operations">
        <h2 className="sidebar-section-label" id="nav-operations">
          {m.identity_nav_operations()}
        </h2>
        <ul className="sidebar-list">{group('operations').map(link)}</ul>
      </section>
      <AppNavigation organizationId={organizationId} close={close} />
      <ul className="sidebar-list sidebar-list-end">
        {group('workspace').map(link)}
      </ul>
    </nav>
  );
}

/** Navigates with `G` followed by a destination key, as in G then I for Issues. */
function useGoShortcuts(organizationId: string) {
  const navigate = useNavigate();
  const adaptive = useQuery(adaptiveAvailabilityOptions(organizationId));

  useEffect(() => {
    let armedAt = 0;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTypingTarget(event.target) ||
        document.querySelector('[role="dialog"]')
      )
        return;
      const key = event.key.toLowerCase();
      if (armedAt && Date.now() - armedAt < 1200) {
        armedAt = 0;
        const destination = workspaceDestinations.find(
          (item) => item.shortcut === key,
        );
        if (
          !destination ||
          (destination.path === 'views' && !adaptive.data?.views)
        )
          return;
        event.preventDefault();
        void navigate({
          to: `/app/$organizationId/${destination.path}`,
          params: { organizationId },
        });

        return;
      }
      armedAt = key === 'g' ? Date.now() : 0;
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, organizationId, adaptive.data?.views]);
}

/** Record pages show linked inbox threads through the kit's record messages slot. */
const recordMessages = (props: RecordMessagesProps) => (
  <RecordMessages {...props} />
);

/** Provides workspace navigation and tenant context for nested application routes. */
export function WorkspaceShell() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });

  return <TenantShell key={organizationId} organizationId={organizationId} />;
}

function TenantShell({ organizationId }: { organizationId: string }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const page = destinationFor(pathname);
  const client = useQueryClient();
  const theme = useThemePreference();
  const access = useQuery(contextOptions(organizationId));
  const permissions = usePermissions(organizationId);
  const organizations = useQuery(organizationsOptions());
  const settings = useQuery({
    ...settingsOptions(organizationId),
    refetchInterval: false,
  });
  const session = client.getQueryData(sessionOptions().queryKey);
  const supportView = session?.supportView ?? null;
  const { end: endView } = useEndSupportView();
  const assistantOpen = useAssistantOpen();
  useGoShortcuts(organizationId);
  useAssistantShortcut();
  if (access.isError)
    return <Failure error={access.error} retry={() => void access.refetch()} />;
  if (organizations.isError)
    return (
      <Failure
        error={organizations.error}
        retry={() => void organizations.refetch()}
      />
    );
  if (access.isPending || organizations.isPending || settings.isPending)
    return <Pending />;
  const organization = organizations.data.find(
    (org) => org.id === organizationId,
  );

  return (
    <WorkspaceLayout
      workspaceSwitcher={
        <WorkspaceSwitcher
          workspace={
            organization?.name ?? m.identity_shell_workspace_fallback()
          }
          workspaceId={organizationId}
          workspaces={organizations.data.map((org) => ({
            id: org.id,
            name: org.name,
            ...(org.membershipStatus === 'suspended'
              ? { status: m.identity_workspaces_suspended() }
              : {}),
            link: (
              <Link
                to="/app/$organizationId/home"
                params={{ organizationId: org.id }}
              />
            ),
          }))}
          createLink={
            supportView ? undefined : <Link to="/app/workspaces/new" />
          }
        />
      }
      banner={
        supportView ? (
          <WorkspaceTimezone value={settings.data?.workspace.timezone ?? 'UTC'}>
            <SupportViewBanner view={supportView} />
          </WorkspaceTimezone>
        ) : null
      }
      search={<WorkspaceSearch organizationId={organizationId} />}
      navigation={(close) => (
        <Navigation organizationId={organizationId} close={close} />
      )}
      context={
        <Link
          to={`/app/$organizationId/${page.path}`}
          params={{ organizationId }}
          className="breadcrumb-root"
        >
          {page.domain ? (
            <DomainIcon domain={page.domain} size="xs" />
          ) : (
            <page.Icon size={15} aria-hidden="true" />
          )}
          <span>{page.label}</span>
        </Link>
      }
      help={
        <>
          <PinCurrentPage organizationId={organizationId} />
          <ContextHelp />
          <AssistantToggle />
        </>
      }
      assistantOpen={assistantOpen}
      assistant={
        <WorkspaceTimezone value={settings.data?.workspace.timezone ?? 'UTC'}>
          <AssistantPanel
            organizationId={organizationId}
            open={assistantOpen}
          />
        </WorkspaceTimezone>
      }
      accountMenu={
        <WorkspaceAccountMenu
          name={session?.user.name ?? m.identity_shell_account_fallback()}
          email={session?.user.email}
          theme={theme}
          onThemeChange={setThemePreference}
          settingsLink={
            <Link
              to="/app/$organizationId/settings"
              params={{ organizationId }}
            />
          }
          docsLink={<a href="/docs" target="_blank" rel="noreferrer" />}
          exit={
            supportView
              ? {
                  label: m.identity_support_view_end(),
                  onSelect: () => void endView(),
                }
              : undefined
          }
        />
      }
    >
      <WorkspaceTimezone value={settings.data?.workspace.timezone ?? 'UTC'}>
        {settings.isError ? (
          <Alert tone="warning" role="status" className="desk-alert">
            {settings.data
              ? m.identity_shell_timezone_stale()
              : m.identity_shell_timezone_unavailable()}
          </Alert>
        ) : null}
        {page.permission && !permissions.can(page.permission) ? (
          <NoAccess
            organizationId={organizationId}
            area={page.area ?? page.label}
            permission={page.permission}
          />
        ) : (
          <RecordMessagesProvider value={recordMessages}>
            <Outlet />
          </RecordMessagesProvider>
        )}
      </WorkspaceTimezone>
    </WorkspaceLayout>
  );
}
