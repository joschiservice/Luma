import type { ApiApp } from '@luma/api-contract';
import { apiAppLifetimeDays } from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Checkbox } from '@luma/ui/components/primitives/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Braces, Check, Copy, Plus } from 'lucide-react';
import { useId, useState } from 'react';

import {
  permissionDescription,
  permissionLabel,
} from '../../kit/identity/permission-text';
import { settingsApi } from '../../kit/settings/data';
import { privateQueryDefaults } from '../../lib/private-query';
import { CommandFeedback, useSettingsCommand } from './command';
import { SectionHeading } from './section-heading';

type Lifetime = (typeof apiAppLifetimeDays)[number];

/** Loads the person's API apps, or every app for people who manage apps, and grantable scopes. */
const apiAppsOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'api-apps'],
    queryFn: ({ signal }) =>
      settingsApi.apiApps.list({ params: { organizationId } }, { signal }),
  });

const statusText = {
  active: m.settings_api_apps_status_active,
  expired: m.settings_api_apps_status_expired,
  revoked: m.settings_api_apps_status_revoked,
} as const;

const statusTone = {
  active: 'success',
  expired: 'warning',
  revoked: 'neutral',
} as const;

const lifetimeOptions = () =>
  apiAppLifetimeDays.map((days) => ({
    value: String(days),
    label: m.settings_api_apps_lifetime_days({ count: days }),
  }));

const isLifetime = (value: number): value is Lifetime =>
  apiAppLifetimeDays.some((days) => days === value);

/** A token returned once after creating or rotating an app; null after a repeated command. */
type Issued = { app: ApiApp; token: string | null };

/**
 * Lets people create personal API apps that read workspace data with a token, limited to the
 * permissions they choose, and rotate or revoke them. People who manage apps see and revoke
 * every app in the workspace. Tokens are shown once and never stored in the browser.
 */
export function ApiAppsSettings({
  organizationId,
  actorId,
  can,
  disabled,
}: {
  organizationId: string;
  actorId: string;
  can: (permission: string) => boolean;
  disabled: boolean;
}) {
  const query = useQuery(apiAppsOptions(organizationId));
  const [dialog, setDialog] = useState<
    | { kind: 'create' }
    | { kind: 'rotate' | 'revoke'; app: ApiApp }
    | { kind: 'issued'; issued: Issued }
    | null
  >(null);
  const canCreate = can('api_apps.create');
  const apps = query.data?.items ?? [];
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <section>
      <SectionHeading
        title={m.settings_api_apps_title()}
        description={m.settings_api_apps_description()}
      />
      <div className="settings-panel settings-api-apps-panel">
        <div className="settings-panel-heading">
          <div>
            <h3>{m.settings_api_apps_access_title()}</h3>
            <p>
              {m.settings_api_apps_access_description({
                address: `${origin}/api`,
              })}{' '}
              <a
                href="/api/openapi.public.json"
                target="_blank"
                rel="noreferrer"
              >
                {m.settings_api_apps_reference()}
              </a>
            </p>
          </div>
          {canCreate ? (
            <Button
              disabled={disabled || !query.data}
              onClick={() => setDialog({ kind: 'create' })}
            >
              <Plus aria-hidden="true" /> {m.settings_api_apps_create()}
            </Button>
          ) : null}
        </div>
        {query.isPending ? (
          <div className="settings-loading" role="status">
            <div />
            <div />
            {m.settings_api_apps_loading()}
          </div>
        ) : null}
        {query.isError ? (
          <Alert tone="danger" role="alert">
            {m.settings_api_apps_load_failed()}{' '}
            <Button variant="outline" onClick={() => void query.refetch()}>
              {m.common_retry()}
            </Button>
          </Alert>
        ) : null}
        {query.data && !apps.length ? (
          <div className="settings-empty">
            <Braces size={23} aria-hidden="true" />
            <strong>{m.settings_api_apps_empty()}</strong>
            <span>
              {canCreate
                ? m.settings_api_apps_empty_create()
                : m.settings_api_apps_empty_no_permission()}
            </span>
          </div>
        ) : null}
        {apps.length ? (
          <ul
            className="settings-passkeys"
            aria-label={m.settings_api_apps_title()}
          >
            {apps.map((app) => (
              <ApiAppRow
                key={app.id}
                app={app}
                mine={app.owner.userId === actorId}
                canRevoke={app.owner.userId === actorId || can('apps.manage')}
                canRotate={app.owner.userId === actorId && canCreate}
                disabled={disabled}
                onRotate={() => setDialog({ kind: 'rotate', app })}
                onRevoke={() => setDialog({ kind: 'revoke', app })}
              />
            ))}
          </ul>
        ) : null}
      </div>
      {dialog?.kind === 'create' && query.data ? (
        <CreateDialog
          organizationId={organizationId}
          scopes={query.data.scopes}
          can={can}
          onClose={() => setDialog(null)}
          onIssued={(issued) => setDialog({ kind: 'issued', issued })}
        />
      ) : null}
      {dialog?.kind === 'rotate' ? (
        <RotateDialog
          organizationId={organizationId}
          app={dialog.app}
          onClose={() => setDialog(null)}
          onIssued={(issued) => setDialog({ kind: 'issued', issued })}
        />
      ) : null}
      {dialog?.kind === 'revoke' ? (
        <RevokeDialog
          organizationId={organizationId}
          app={dialog.app}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'issued' ? (
        <IssuedDialog issued={dialog.issued} onClose={() => setDialog(null)} />
      ) : null}
    </section>
  );
}

function scopeList(scopes: string[]) {
  return formatList(scopes.map((scope) => permissionLabel(scope, scope)));
}

function ApiAppRow({
  app,
  mine,
  canRevoke,
  canRotate,
  disabled,
  onRotate,
  onRevoke,
}: {
  app: ApiApp;
  mine: boolean;
  canRevoke: boolean;
  canRotate: boolean;
  disabled: boolean;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  return (
    <li className="settings-member settings-api-app">
      <span className="settings-member-identity">
        <strong>
          {app.name}{' '}
          <Badge tone={statusTone[app.status]}>
            {statusText[app.status]()}
          </Badge>
        </strong>
        {!mine ? (
          <span>
            {m.settings_api_apps_acts_for({
              name: app.owner.name ?? m.settings_api_apps_former_member(),
            })}
          </span>
        ) : null}
        <span>
          {m.settings_api_apps_scopes({ scopes: scopeList(app.scopes) })}
        </span>
        {app.lastFour ? (
          <span>
            {m.settings_api_apps_token_ending({ lastFour: app.lastFour })}
          </span>
        ) : null}
        {app.status === 'active' && app.expiresAt ? (
          <span>
            {m.settings_api_apps_expires()}{' '}
            <WorkspaceDate value={app.expiresAt} />
          </span>
        ) : null}
        {app.status === 'expired' && app.expiresAt ? (
          <span>
            {m.settings_api_apps_expired()}{' '}
            <WorkspaceDate value={app.expiresAt} />
          </span>
        ) : null}
        <span>
          {app.lastUsedAt ? (
            <>
              {m.settings_api_apps_last_used()}{' '}
              <WorkspaceDate value={app.lastUsedAt} />
            </>
          ) : (
            m.settings_api_apps_never_used()
          )}
        </span>
        {app.personalDataReads.requests > 0 ? (
          <span>
            {m.settings_api_apps_personal_reads({
              records: app.personalDataReads.records,
            })}
          </span>
        ) : null}
      </span>
      {app.status !== 'revoked' ? (
        <span className="settings-invitation-actions">
          {canRotate ? (
            <Button variant="outline" disabled={disabled} onClick={onRotate}>
              {m.settings_api_apps_rotate()}
            </Button>
          ) : null}
          {canRevoke ? (
            <Button variant="outline" disabled={disabled} onClick={onRevoke}>
              {m.settings_api_apps_revoke()}
            </Button>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

function LifetimeField({
  value,
  onChange,
  disabled,
}: {
  value: Lifetime;
  onChange: (value: Lifetime) => void;
  disabled: boolean;
}) {
  const id = useId();

  return (
    <>
      <label htmlFor={id}>{m.settings_api_apps_lifetime_label()}</label>
      <Select
        id={id}
        value={String(value)}
        options={lifetimeOptions()}
        disabled={disabled}
        onValueChange={(next) => {
          const days = Number(next);
          if (isLifetime(days)) onChange(days);
        }}
      />
    </>
  );
}

function CreateDialog({
  organizationId,
  scopes,
  can,
  onClose,
  onIssued,
}: {
  organizationId: string;
  scopes: { key: string; sensitive: boolean }[];
  can: (permission: string) => boolean;
  onClose: () => void;
  onIssued: (issued: Issued) => void;
}) {
  const command = useSettingsCommand(organizationId);
  const nameId = useId();
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [lifetime, setLifetime] = useState<Lifetime>(90);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{m.settings_api_apps_create_title()}</DialogTitle>
        <DialogDescription>
          {m.settings_api_apps_create_description()}
        </DialogDescription>
        <form
          className="settings-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void command.run(async (commandId) => {
              onIssued(
                await settingsApi.apiApps.create({
                  params: { organizationId },
                  headers: { 'x-command-id': commandId },
                  body: {
                    name: name.trim(),
                    scopes: chosen,
                    lifetimeDays: lifetime,
                  },
                }),
              );
            }, m.settings_api_apps_created());
          }}
        >
          <label htmlFor={nameId}>{m.settings_api_apps_name_label()}</label>
          <Input
            id={nameId}
            value={name}
            maxLength={80}
            required
            disabled={command.locked}
            placeholder={m.settings_api_apps_name_placeholder()}
            onChange={(event) => setName(event.target.value)}
          />
          <fieldset className="settings-api-app-scopes">
            <legend>{m.settings_api_apps_scopes_label()}</legend>
            {scopes.map((scope) => {
              const held = can(scope.key);

              return (
                <label key={scope.key} className="settings-api-app-scope">
                  <Checkbox
                    checked={chosen.includes(scope.key)}
                    disabled={!held || command.locked}
                    onChange={(event) =>
                      setChosen((current) =>
                        event.target.checked
                          ? [...current, scope.key]
                          : current.filter((key) => key !== scope.key),
                      )
                    }
                  />
                  <span>
                    <strong>
                      {permissionLabel(scope.key, scope.key)}{' '}
                      {scope.sensitive ? (
                        <Badge tone="warning">
                          {m.settings_api_apps_sensitive()}
                        </Badge>
                      ) : null}
                    </strong>
                    <small>
                      {held
                        ? permissionDescription(scope.key, '')
                        : m.settings_api_apps_scope_not_held()}
                    </small>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <LifetimeField
            value={lifetime}
            onChange={setLifetime}
            disabled={command.locked}
          />
          <CommandFeedback command={command} />
          <div className="settings-dialog-actions">
            <Button
              type="button"
              variant="outline"
              disabled={command.locked}
              onClick={onClose}
            >
              {m.common_cancel()}
            </Button>
            <Button
              type="submit"
              disabled={command.locked || !name.trim() || !chosen.length}
            >
              {m.settings_api_apps_create()}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RotateDialog({
  organizationId,
  app,
  onClose,
  onIssued,
}: {
  organizationId: string;
  app: ApiApp;
  onClose: () => void;
  onIssued: (issued: Issued) => void;
}) {
  const command = useSettingsCommand(organizationId);
  const [lifetime, setLifetime] = useState<Lifetime>(90);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>
          {m.settings_api_apps_rotate_title({ name: app.name })}
        </DialogTitle>
        <DialogDescription>
          {m.settings_api_apps_rotate_description()}
        </DialogDescription>
        <div className="settings-dialog-form">
          <LifetimeField
            value={lifetime}
            onChange={setLifetime}
            disabled={command.locked}
          />
          <CommandFeedback command={command} />
          <div className="settings-dialog-actions">
            <Button
              variant="outline"
              disabled={command.locked}
              onClick={onClose}
            >
              {m.common_cancel()}
            </Button>
            <Button
              disabled={command.locked}
              onClick={() =>
                void command.run(async (commandId) => {
                  onIssued(
                    await settingsApi.apiApps.rotate({
                      params: { organizationId, appId: app.id },
                      headers: { 'x-command-id': commandId },
                      body: { lifetimeDays: lifetime },
                    }),
                  );
                }, m.settings_api_apps_rotated())
              }
            >
              {m.settings_api_apps_rotate()}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({
  organizationId,
  app,
  onClose,
}: {
  organizationId: string;
  app: ApiApp;
  onClose: () => void;
}) {
  const command = useSettingsCommand(organizationId);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>
          {m.settings_api_apps_revoke_title({ name: app.name })}
        </DialogTitle>
        <DialogDescription>
          {m.settings_api_apps_revoke_description()}
        </DialogDescription>
        <CommandFeedback command={command} />
        <div className="settings-dialog-actions">
          <Button variant="outline" disabled={command.locked} onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button
            variant="destructive"
            disabled={command.locked}
            onClick={() =>
              void command.run(async (commandId) => {
                await settingsApi.apiApps.revoke({
                  params: { organizationId, appId: app.id },
                  headers: { 'x-command-id': commandId },
                });
                onClose();
              }, m.settings_api_apps_revoked())
            }
          >
            {m.settings_api_apps_revoke()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function IssuedDialog({
  issued,
  onClose,
}: {
  issued: Issued;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const { token } = issued;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{m.settings_api_apps_token_title()}</DialogTitle>
        <DialogDescription>
          {token
            ? m.settings_api_apps_token_description()
            : m.settings_api_apps_token_unavailable()}
        </DialogDescription>
        {token ? (
          <div className="settings-backup-codes settings-api-app-token">
            <code aria-label={m.settings_api_apps_token_label()}>{token}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCopyFailed(false);
                void navigator.clipboard
                  ?.writeText(token)
                  .then(() => setCopied(true))
                  .catch(() => setCopyFailed(true));
              }}
            >
              {copied ? (
                <Check aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
              {copied ? m.common_copied() : m.common_copy()}
            </Button>
            {copyFailed ? (
              <Alert tone="warning" role="alert">
                {m.settings_api_apps_copy_failed()}
              </Alert>
            ) : null}
          </div>
        ) : null}
        <div className="settings-dialog-actions">
          <span />
          <Button onClick={onClose}>{m.settings_api_apps_done()}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
