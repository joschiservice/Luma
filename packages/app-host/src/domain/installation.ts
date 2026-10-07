import { IdentityError } from '@luma/identity';

export interface WorkspaceApp {
  appId: string;
  status: 'installed' | 'uninstalled';
  version: number;
  updatedAt: string;
  /** Scopes granted to the current installation; empty after uninstall. */
  grantedScopes: string[];
}

/** Checks optimistic lifecycle transitions; reinstalls always create a new installation version. */
export function nextInstallation(
  current: { version: number; status: WorkspaceApp['status'] } | undefined,
  appId: string,
  version: number | null,
  installed: boolean,
): Omit<WorkspaceApp, 'grantedScopes'> {
  if ((current?.version ?? null) !== version)
    throw new IdentityError(
      409,
      'CONFLICT',
      'App installation changed; refresh and retry',
    );
  if (!installed && !current)
    throw new IdentityError(404, 'NOT_FOUND', 'App is not installed');
  const status = installed ? 'installed' : 'uninstalled';
  if (current?.status === status)
    throw new IdentityError(409, 'CONFLICT', 'App is already in this state');

  return {
    appId,
    status,
    version: (current?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
}
