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
import { Menu } from 'lucide-react';
import { type ReactNode, useState } from 'react';

type WorkspaceLayoutProps = {
  brand: ReactNode;
  navigation: (close?: () => void) => ReactNode;
  workspaceSwitcher?: ReactNode;
  context?: ReactNode;
  search?: ReactNode;
  accountMenu: ReactNode;
  children: ReactNode;
};

/** Renders responsive workspace navigation, account controls, and page content. */
export function WorkspaceLayout({
  brand,
  navigation,
  workspaceSwitcher,
  context,
  search,
  accountMenu,
  children,
}: WorkspaceLayoutProps) {
  const [open, setOpen] = useState(false);
  const [pageHeader, setPageHeader] = useState<HTMLDivElement | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<HTMLSpanElement | null>(null);

  return (
    <WorkspaceHeaderSlot.Provider value={pageHeader}>
      <WorkspaceBreadcrumbSlot.Provider value={breadcrumb}>
        <div className="desk">
          <a className="skip-link" href="#workspace-content">
            Skip to content
          </a>
          <aside className="desk-sidebar">
            {brand}
            {navigation()}
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
                    <Menu size={20} aria-hidden="true" />
                  </DialogTrigger>
                  <DialogContent className="navigation-drawer translate-x-0 translate-y-0">
                    <DialogTitle>Navigation</DialogTitle>
                    <DialogDescription>
                      Choose a destination in this workspace.
                    </DialogDescription>
                    {navigation(() => setOpen(false))}
                  </DialogContent>
                </Dialog>
              </div>
              <div className="workspace-default-header">
                <nav className="header-context" aria-label="Breadcrumb">
                  <span className="workspace-default-breadcrumb">
                    {context}
                  </span>
                  <span
                    className="workspace-route-breadcrumb"
                    ref={setBreadcrumb}
                  />
                </nav>
                {search}
                {workspaceSwitcher}
              </div>
              <div className="workspace-page-header" ref={setPageHeader} />
              {accountMenu}
            </header>
            <main id="workspace-content" tabIndex={-1} className="desk-content">
              {children}
            </main>
          </div>
        </div>
      </WorkspaceBreadcrumbSlot.Provider>
    </WorkspaceHeaderSlot.Provider>
  );
}
