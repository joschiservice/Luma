import type { AppManifest } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
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

import {
  permissionDescription,
  permissionLabel,
} from '../../kit/identity/permission-text';
import { usePermissions } from '../../kit/identity/permissions';
import { rolesOptions } from '../../kit/settings/roles-data';

/**
 * Describes core permissions in people-facing words in the interface language, using the workspace
 * catalog for permissions the client doesn't know.
 */
function useScopeLabels(organizationId: string) {
  const roles = useQuery({ ...rolesOptions(organizationId), retry: false });

  return (key: string) => {
    const permission = roles.data?.permissions.find((item) => item.key === key);

    return {
      label: permissionLabel(key, permission?.label ?? key),
      description: permissionDescription(key, permission?.description ?? ''),
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
  const sensitive = scopes.some((scope) => describe(scope).consequential);

  return (
    <>
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
                  {consequential ? (
                    <Badge tone="warning">{m.apps_access_sensitive()}</Badge>
                  ) : null}
                </strong>
                <span>
                  {missing ? m.apps_access_scope_not_grantable() : description}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {sensitive ? (
        <p className="apps-note">{m.apps_access_sensitive_note()}</p>
      ) : null}
    </>
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
            ? m.apps_access_install_title({ app: app.name })
            : m.apps_access_approve_title({ app: app.name })}
        </DialogTitle>
        <DialogDescription>
          {mode === 'install'
            ? m.apps_access_install_description({ app: app.name })
            : m.apps_access_approve_description({ app: app.name })}
        </DialogDescription>
        {scopes.length ? (
          <div className="app-access-section">
            <h3>
              {mode === 'install'
                ? m.apps_access_scopes_title({ app: app.name })
                : m.apps_access_scopes_new_title({ app: app.name })}
            </h3>
            <ScopeList
              organizationId={organizationId}
              scopes={scopes}
              checkGrantable
            />
          </div>
        ) : (
          <p className="apps-note">
            {m.apps_access_no_scopes({ app: app.name })}
          </p>
        )}
        {mode === 'install' && app.permissions.length ? (
          <div className="app-access-section">
            <h3>{m.apps_access_permissions_title()}</h3>
            <ul className="app-scopes">
              {app.permissions.map((permission) => (
                <li key={permission.key}>
                  <KeyRound size={14} aria-hidden="true" />
                  <span>
                    <strong>
                      {permission.label}
                      {permission.consequential ? (
                        <Badge tone="warning">
                          {m.apps_access_sensitive()}
                        </Badge>
                      ) : null}
                    </strong>
                    <span>{permission.description}</span>
                  </span>
                </li>
              ))}
            </ul>
            {app.permissions.some((permission) => permission.consequential) ? (
              <p className="apps-note">{m.apps_access_sensitive_note()}</p>
            ) : null}
            <p className="apps-note">{m.apps_access_permissions_note()}</p>
          </div>
        ) : null}
        {missing.length ? (
          <Alert tone="warning">
            {mode === 'install'
              ? m.apps_access_missing_install({ app: app.name })
              : m.apps_access_missing_approve()}
          </Alert>
        ) : null}
        {error ? (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={close}>
            {m.common_cancel()}
          </Button>
          <Button disabled={pending || !!missing.length} onClick={confirm}>
            {pending
              ? mode === 'install'
                ? m.apps_access_installing()
                : m.apps_access_approving()
              : mode === 'install'
                ? m.apps_access_install_confirm({ app: app.name })
                : m.apps_access_approve_confirm()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
