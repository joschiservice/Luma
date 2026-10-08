import { m } from '@luma/i18n/messages';
import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

/** Hosts route-specific breadcrumbs inside the workspace navigation. */
export const WorkspaceBreadcrumbSlot = createContext<HTMLElement | null>(null);

/** Replaces the default breadcrumb while mounted. Renders inline outside a workspace shell. */
export function WorkspaceBreadcrumb({ children }: { children: ReactNode }) {
  const target = useContext(WorkspaceBreadcrumbSlot);

  return target ? (
    createPortal(children, target)
  ) : (
    <nav aria-label={m.ui_breadcrumb_label()}>{children}</nav>
  );
}
