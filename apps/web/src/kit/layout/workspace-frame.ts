import { createContext, useContext } from 'react';

/**
 * Holds the workspace whose shell frames the current page, or `null` outside the shell. Route
 * status pages read it to render inside the workspace frame instead of a full entry page.
 */
export const WorkspaceFrame = createContext<string | null>(null);

/** Returns the workspace that frames the current page, or `null` outside the workspace shell. */
export function useWorkspaceFrame() {
  return useContext(WorkspaceFrame);
}
