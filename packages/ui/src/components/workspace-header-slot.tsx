import { createContext } from 'react';

/** Hosts page-specific navigation in the workspace bar without moving account controls. */
export const WorkspaceHeaderSlot = createContext<HTMLElement | null>(null);
