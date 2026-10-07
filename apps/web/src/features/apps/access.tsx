import type { AppManifest } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { useQuery } from '@tanstack/react-query';
import { Check, KeyRound, LockKeyhole } from 'lucide-react';

import { usePermissions } from '../identity/permissions';
import { rolesOptions } from '../settings/roles-data';

/** Describes core permissions in people-facing words, using the workspace catalog. */
function useScopeLabels(organizationId: string) {
  const roles = useQuery({ ...rolesOptions(organizationId), retry: false });

  return (key: string) => {
    const permission = roles.data?.permissions.find((item) => item.key === key);

    return {
      label: permission?.label ?? key,
      description: permission?.description ?? '',
      consequential: permission?.consequential ?? false,
    };
  };
}

/** Lists the Luma data and actions an app may use, marking scopes the reader can't grant. */
export function ScopeList({
  organizationId,
  scopes,
  checkGrantable = false,
}: {
  organizationId: string;
  scopes: readonly string[];
  checkGrantable?: boolean;
}) {
  const describe = useScopeLabels(organizationId);
  const { can } = usePermissions(organizationId);

  return (
    <ul className="app-scopes">
      {scopes.map((scope) => {
        const { label, description, consequential } = describe(scope);
        const missing = checkGrantable && !can(scope);

        return (
          <li key={scope} data-missing={missing || undefined}>
            {missing ? (
              <LockKeyhole size={14} aria-hidden="true" />
            ) : (
              <Check size={14} aria-hidden="true" />
            )}
            <span>
              <strong>
                {label}
                {consequential ? <Badge tone="warning">Sensitive</Badge> : null}
              </strong>
              <span>
                {missing
                  ? 'Your role doesn’t include this, so you can’t grant it.'
                  : description}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Asks for consent before an app is installed or gains access an upgrade requests. Shows the
 * access in plain language and the permissions the app adds to roles; only access the reader
 * holds can be granted.
 */
export function AppAccessDialog({
  organizationId,
  app,
  scopes,
  mode,
  open,
  pending,
  error,
  close,
  confirm,
}: {
  organizationId: string;
  app: AppManifest;
  /** The scopes to grant: all requested ones on install, the new ones on approval. */
  scopes: readonly string[];
  mode: 'install' | 'approve';
  open: boolean;
  pending: boolean;
  error: string;
  close: () => void;
  confirm: () => void;
}) {
  const { can } = usePermissions(organizationId);
  const missing = scopes.filter((scope) => !can(scope));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) close();
      }}
    >
      <DialogContent className="app-access-dialog">
        <DialogTitle>
          {mode === 'install'
            ? `Install ${app.name}?`
            : `Review new access for ${app.name}`}
        </DialogTitle>
        <DialogDescription>
          {mode === 'install'
            ? `${app.name} can use this workspace data and these actions for the people who use it. It never does more than their own role allows.`
            : `The latest version of ${app.name} asks for more access. Until you approve it, ${app.name} keeps working with the access it already has.`}
        </DialogDescription>
        {scopes.length ? (
          <div className="app-access-section">
            <h3>{app.name} can</h3>
            <ScopeList
              organizationId={organizationId}
              scopes={scopes}
              checkGrantable
            />
          </div>
        ) : (
          <p className="apps-note">This app doesn’t use any workspace data.</p>
        )}
        {mode === 'install' && app.permissions.length ? (
          <div className="app-access-section">
            <h3>Adds permissions to Roles</h3>
            <ul className="app-scopes">
              {app.permissions.map((permission) => (
                <li key={permission.key}>
                  <KeyRound size={14} aria-hidden="true" />
                  <span>
                    <strong>
                      {permission.label}
                      {permission.consequential ? (
                        <Badge tone="warning">Sensitive</Badge>
                      ) : null}
                    </strong>
                    <span>{permission.description}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="apps-note">
              Owners and admins get these automatically. Grant them to custom
              roles in Settings → Roles.
            </p>
          </div>
        ) : null}
        {missing.length ? (
          <Alert tone="warning">
            You can only grant access your role includes. Ask an owner to{' '}
            {mode === 'install' ? 'install this app' : 'approve this access'}.
          </Alert>
        ) : null}
        {error ? (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button disabled={pending || !!missing.length} onClick={confirm}>
            {pending
              ? mode === 'install'
                ? 'Installing…'
                : 'Approving…'
              : mode === 'install'
                ? 'Install and grant access'
                : 'Approve access'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
