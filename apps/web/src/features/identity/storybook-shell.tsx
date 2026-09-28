import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import {
  type ThemeChoice,
  WorkspaceAccountMenu,
} from '@luma/ui/components/workspace/workspace-account-menu';
import { WorkspaceSwitcher } from '@luma/ui/components/workspace/workspace-switcher';
import { type ReactNode, useState } from 'react';

import appStyles from '../../styles.css?inline';
import { workspaceDestinations } from './workspace-destinations';
import { WorkspaceLayout } from './workspace-layout';

/** Page labels available in story navigation. */
export type StoryPage = (typeof workspaceDestinations)[number]['label'];

/**
 * Renders the production workspace frame with fixture navigation, workspace and account
 * data for app stories. Mounts the app stylesheet only while the story is visible.
 */
export function StoryShell({
  page: initialPage = 'Home',
  workspace: initialWorkspace = 'Northstar Commerce',
  account = 'Alex Morgan',
  email = 'alex@northstar.example',
  attention = 3,
  children,
}: {
  page?: StoryPage;
  workspace?: string;
  account?: string;
  email?: string;
  attention?: number;
  children?: ReactNode | ((page: string) => ReactNode);
}) {
  const [page, setPage] = useState<string>(initialPage);
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [theme, setTheme] = useState<ThemeChoice>('system');
  const current =
    workspaceDestinations.find((item) => item.label === page) ??
    workspaceDestinations[0]!;
  const link = (
    item: (typeof workspaceDestinations)[number],
    close?: () => void,
  ) => (
    <li key={item.path}>
      <a
        className="sidebar-link"
        data-label={item.label}
        href={`#${item.path}`}
        aria-current={page === item.label ? 'page' : undefined}
        onClick={(event) => {
          event.preventDefault();
          setPage(item.label);
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
        <span className="sidebar-link-label">{item.label}</span>
        {item.path === 'exceptions' && attention ? (
          <span className="sidebar-link-count">
            {attention}
            <span className="sr-only"> need you</span>
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
          <nav aria-label="Workspace navigation" className="sidebar-nav">
            <ul className="sidebar-list">
              {workspaceDestinations
                .filter((item) => item.group === 'core')
                .map((item) => link(item, close))}
            </ul>
            <section className="sidebar-section">
              <h2 className="sidebar-section-label">Operations</h2>
              <ul className="sidebar-list">
                {workspaceDestinations
                  .filter((item) => item.group === 'operations')
                  .map((item) => link(item, close))}
              </ul>
            </section>
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
      >
        {typeof children === 'function' ? children(page) : children}
      </WorkspaceLayout>
    </>
  );
}
