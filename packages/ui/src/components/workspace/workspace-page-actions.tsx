import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

/** Hosts page-level actions in the workspace bar, beside the account and help controls. */
export const WorkspacePageActionsSlot = createContext<HTMLElement | null>(null);

/** Shows page-level actions in the workspace bar while mounted. Renders inline outside a workspace shell. */
export function WorkspacePageActions({ children }: { children: ReactNode }) {
  const target = useContext(WorkspacePageActionsSlot);

  return target ? (
    createPortal(children, target)
  ) : (
    <div className="page-header-actions">{children}</div>
  );
}
