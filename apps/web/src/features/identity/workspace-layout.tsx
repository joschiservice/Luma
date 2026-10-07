import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@luma/ui/components/primitives/dialog';
import { WorkspaceBreadcrumbSlot } from '@luma/ui/components/workspace/workspace-breadcrumb';
import { WorkspaceHeaderSlot } from '@luma/ui/components/workspace/workspace-header-slot';
import { WorkspacePageActionsSlot } from '@luma/ui/components/workspace/workspace-page-actions';
import { Menu, PanelLeft } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { isTypingTarget } from '../../lib/keyboard';
import {
  readSidebarCollapsed,
  setSidebarCollapsed,
  useSidebarCollapsed,
} from '../../lib/sidebar';

type WorkspaceLayoutProps = {
  workspaceSwitcher: ReactNode;
  navigation: (close?: () => void) => ReactNode;
  accountMenu: ReactNode;
  search?: ReactNode;
  context?: ReactNode;
  help?: ReactNode;
  /** A panel docked beside the page, shown while `assistantOpen` is true. */
  assistant?: ReactNode;
  assistantOpen?: boolean;
  children: ReactNode;
};

/**
 * Renders the workspace frame: a persistent sidebar that collapses to an icon rail,
 * a compact top bar with breadcrumbs, page actions and workspace controls, and the scrollable page.
 * Small screens move the sidebar into a navigation drawer. Press `[` to collapse. An optional
 * assistant panel docks to the right of the page, or covers it on small screens.
 */
export function WorkspaceLayout({
  workspaceSwitcher,
  navigation,
  accountMenu,
  search,
  context,
  help,
  assistant,
  assistantOpen = false,
  children,
}: WorkspaceLayoutProps) {
  const [open, setOpen] = useState(false);
  const [pageHeader, setPageHeader] = useState<HTMLDivElement | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<HTMLSpanElement | null>(null);
  const [pageActions, setPageActions] = useState<HTMLDivElement | null>(null);
  const collapsed = useSidebarCollapsed();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== '[' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTypingTarget(event.target)
      )
        return;
      event.preventDefault();
      setSidebarCollapsed(!readSidebarCollapsed());
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <WorkspaceHeaderSlot.Provider value={pageHeader}>
      <WorkspaceBreadcrumbSlot.Provider value={breadcrumb}>
        <WorkspacePageActionsSlot.Provider value={pageActions}>
          <div
            className="desk"
            data-sidebar={collapsed ? 'collapsed' : 'expanded'}
            data-assistant={assistant && assistantOpen ? 'open' : 'closed'}
          >
            <a className="skip-link" href="#workspace-content">
              Skip to content
            </a>
            <aside className="desk-sidebar" aria-label="Workspace">
              <div className="sidebar-top">
                {workspaceSwitcher}
                <Button
                  variant="ghost"
                  size="icon"
                  className="sidebar-collapse"
                  aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  aria-pressed={collapsed}
                  title={`${collapsed ? 'Expand' : 'Collapse'} sidebar ( [ )`}
                  onClick={() => setSidebarCollapsed(!collapsed)}
                >
                  <PanelLeft aria-hidden="true" />
                </Button>
              </div>
              {search}
              <div className="sidebar-scroll">{navigation()}</div>
              <div className="sidebar-bottom">{accountMenu}</div>
            </aside>
            <div className="desk-body">
              <header className="desk-header">
                <div className="mobile-nav">
                  <Dialog open={open} onOpenChange={setOpen}>
                    <DialogTrigger
                      render={
                        <Button variant="ghost" size="icon" aria-label="Menu" />
                      }
                    >
                      <Menu aria-hidden="true" />
                    </DialogTrigger>
                    <DialogContent
                      className="navigation-drawer"
                      showCloseButton={false}
                    >
                      <DialogTitle className="sr-only">Navigation</DialogTitle>
                      <DialogDescription className="sr-only">
                        Choose a destination in this workspace.
                      </DialogDescription>
                      <div className="sidebar-top">{workspaceSwitcher}</div>
                      <div className="sidebar-scroll">
                        {navigation(() => setOpen(false))}
                      </div>
                      <div className="sidebar-bottom">{accountMenu}</div>
                    </DialogContent>
                  </Dialog>
                </div>
                <nav className="header-context" aria-label="Breadcrumb">
                  <span className="workspace-default-breadcrumb">
                    {context}
                  </span>
                  <span
                    className="workspace-route-breadcrumb"
                    ref={setBreadcrumb}
                  />
                </nav>
                <div className="workspace-page-header" ref={setPageHeader} />
                <div className="workspace-page-actions" ref={setPageActions} />
                <div className="desk-header-tools">{help}</div>
              </header>
              <main
                id="workspace-content"
                tabIndex={-1}
                className="desk-content"
              >
                {children}
              </main>
            </div>
            {assistant}
          </div>
        </WorkspacePageActionsSlot.Provider>
      </WorkspaceBreadcrumbSlot.Provider>
    </WorkspaceHeaderSlot.Provider>
  );
}
