import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import {
  type ThemeChoice,
  WorkspaceAccountMenu,
} from '@luma/ui/components/workspace/workspace-account-menu';
import { WorkspaceSwitcher } from '@luma/ui/components/workspace/workspace-switcher';
import { type ReactNode, useState } from 'react';

import { SidebarLinkLabel } from '../kit/layout/sidebar-link-label';
import appStyles from '../styles.css?inline';
import { RecordsNavigation } from './records-navigation';
import { workspaceDestinations } from './workspace-destinations';
import { WorkspaceLayout } from './workspace-layout';

/** A page in story navigation, named by its path, such as `exceptions`. */
export type StoryPage = string;

/**
 * Renders the production workspace frame with fixture navigation, workspace and account
 * data for app stories. Mounts the app stylesheet only while the story is visible.
 */
export function StoryShell({
  page: initialPage = 'home',
  workspace: initialWorkspace = 'Northstar Commerce',
  account = 'Alex Morgan',
  email = 'alex@northstar.example',
  attention = 3,
  assistant,
  children,
}: {
  page?: StoryPage;
  workspace?: string;
  account?: string;
  email?: string;
  attention?: number;
  /** An open assistant panel docked beside the page. */
  assistant?: ReactNode;
  children?: ReactNode | ((page: string) => ReactNode);
}) {
  const [path, setPath] = useState(
    () =>
      (
        workspaceDestinations.find((item) => item.path === initialPage) ??
        workspaceDestinations[0]!
      ).path,
  );
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [theme, setTheme] = useState<ThemeChoice>('system');
  const current =
    workspaceDestinations.find((item) => item.path === path) ??
    workspaceDestinations[0]!;
  const page = current.label;
  const link = (
    item: (typeof workspaceDestinations)[number],
    close?: () => void,
  ) => (
    <li key={item.path}>
      <a
        className="sidebar-link"
        data-label={item.label}
        href={`#${item.path}`}
        aria-current={path === item.path ? 'page' : undefined}
        onClick={(event) => {
          event.preventDefault();
          setPath(item.path);
          close?.();
        }}
      >
        {item.domain ? (
          <DomainIcon domain={item.domain} size="xs" />
        ) : (
          <item.Icon
            className="sidebar-link-icon"
            size={16}
            aria-hidden="true"
          />
        )}
        <SidebarLinkLabel>{item.label}</SidebarLinkLabel>
        {item.path === 'needs-you' && attention ? (
          <span className="sidebar-link-count">
            <span aria-hidden="true">{formatNumber(attention)}</span>
            <span className="sr-only">
              {m.identity_nav_waiting_count({ count: attention })}
            </span>
          </span>
        ) : null}
      </a>
    </li>
  );

  return (
    <>
      <style>{appStyles}</style>
      <WorkspaceLayout
        workspaceSwitcher={
          <WorkspaceSwitcher
            workspace={workspace}
            workspaceId={workspace}
            workspaces={[initialWorkspace, 'Northstar Europe'].map((name) => ({
              id: name,
              name,
              link: (
                <a
                  href="#workspace"
                  onClick={(event) => {
                    event.preventDefault();
                    setWorkspace(name);
                  }}
                />
              ),
            }))}
            createLink={<a href="#create-workspace" />}
          />
        }
        navigation={(close) => (
          <nav aria-label={m.identity_nav_label()} className="sidebar-nav">
            <ul className="sidebar-list">
              {workspaceDestinations
                .filter((item) => item.group === 'core')
                .map((item) => link(item, close))}
            </ul>
            <section className="sidebar-section">
              <h2 className="sidebar-section-label">
                {m.identity_nav_operations()}
              </h2>
              <ul className="sidebar-list">
                {workspaceDestinations
                  .filter((item) => item.group === 'operations')
                  .map((item) => link(item, close))}
              </ul>
            </section>
            <RecordsNavigation
              key={current.group === 'records' ? current.path : 'closed'}
              active={current.group === 'records'}
            >
              {workspaceDestinations
                .filter((item) => item.group === 'records')
                .map((item) => link(item, close))}
            </RecordsNavigation>
            <ul className="sidebar-list sidebar-list-end">
              {workspaceDestinations
                .filter((item) => item.group === 'workspace')
                .map((item) => link(item, close))}
            </ul>
          </nav>
        )}
        context={
          <a className="breadcrumb-root" href={`#${current.path}`}>
            {current.domain ? (
              <DomainIcon domain={current.domain} size="xs" />
            ) : (
              <current.Icon size={15} aria-hidden="true" />
            )}
            <span>{current.label}</span>
          </a>
        }
        accountMenu={
          <WorkspaceAccountMenu
            name={account}
            email={email}
            theme={theme}
            onThemeChange={setTheme}
            settingsLink={<a href="#settings" />}
            docsLink={<a href="#docs" />}
          />
        }
        assistant={assistant}
        assistantOpen={!!assistant}
      >
        {typeof children === 'function' ? children(page) : children}
      </WorkspaceLayout>
    </>
  );
}
