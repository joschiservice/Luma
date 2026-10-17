import {
  type InstalledConnection,
  type SyncConnectionView,
  type SyncRecordType,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@luma/ui/components/primitives/dropdown-menu';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { operatorCodeLabel } from '@luma/ui/lib/operator-code';
import { Link } from '@tanstack/react-router';
import {
  Check,
  Eye,
  Minus,
  MoreHorizontal,
  Pencil,
  PenLine,
  RotateCcw,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import {
  changeConnection,
  changeConnectionWriteMode,
  connectionError,
  renameConnection,
} from '../../kit/connections/data';
import {
  capabilities,
  connectionAccess,
  connectionKindName,
  connectionState,
  connectionSystem,
  connectionTarget,
} from '../../kit/connections/presentation';
import { recordTypes } from '../sync/presentation';
import { AppExtension } from './extension';
import { ConnectionHistory } from './history';
import { RelativeTime } from './presentation';

const accessLevels = {
  read_write: m.connections_access_level_read_write,
  read_only: m.connections_access_level_read_only,
  none: m.connections_access_level_none,
};

/**
 * Shows one connection: its state and what to do about it, when Luma last read from it, what
 * it may read and change, and the management actions the reader may use. Refreshes the list
 * after every change, including failed ones, because an uncertain result needs a fresh read.
 */
export function ConnectionCard({
  connection,
  organizationId,
  canManage,
  appAvailable = true,
  refresh,
  sync,
  owner = false,
  workspaceWriteMode,
  canReadHistory = false,
}: {
  connection: InstalledConnection;
  organizationId: string;
  canManage: boolean;
  /** Fresh owner access and workspace mode, loaded once by the settings page. */
  owner?: boolean;
  workspaceWriteMode?: 'observe_only' | 'writes_enabled' | undefined;
  appAvailable?: boolean;
  refresh: () => Promise<void>;
  /** Import and sync state for this connection, when loaded. */
  sync?: SyncConnectionView | undefined;
  /** Whether the reader may see restricted activity, which holds connection events. */
  canReadHistory?: boolean;
}) {
  const [dialog, setDialog] = useState<
    'settings' | 'disconnect' | 'rename' | null
  >(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  useEffect(() => {
    if (window.location.hash !== `#connection-${connection.id}`) return;
    const element = document.getElementById(`connection-${connection.id}`);
    element?.scrollIntoView({ block: 'start' });
    element?.focus({ preventScroll: true });
  }, [connection.id]);

  // People disconnect; only providers revoke, and a revoked connection can be reconnected.
  const terminal = connection.status === 'disconnected';
  const revoked = connection.status === 'revoked';
  const state = connectionState(connection);
  const access = connectionAccess(connection, appAvailable);
  const system = connectionSystem(connection.target.kind);
  const target = connectionTarget(connection.target);
  const canCheck =
    appAvailable &&
    !revoked &&
    !terminal &&
    (!connection.management || connection.management.includes('check'));
  const canOpenSettings = appAvailable && !!connection.appId;
  const urgent = ['pending', 'degraded'].includes(connection.status);
  const writes =
    connection.writeMode === 'observe_only'
      ? m.connections_writes_connection_observe()
      : !access.changes.length
        ? null
        : workspaceWriteMode === 'observe_only'
          ? m.connections_writes_workspace_observe()
          : workspaceWriteMode === 'writes_enabled'
            ? m.connections_writes_enabled()
            : null;
  const note = !appAvailable
    ? m.connections_card_app_unavailable()
    : terminal
      ? m.connections_card_disconnected()
      : revoked
        ? m.connections_card_revoked({ system })
        : connection.status === 'pending'
          ? m.connections_card_pending()
          : connection.status === 'degraded'
            ? m.connections_card_needs_validation()
            : connection.coverage?.health === 'importing'
              ? m.connections_card_importing()
              : connection.coverage?.health === 'delayed'
                ? m.connections_card_delayed()
                : null;
  const streams = terminal ? [] : (connection.coverage?.streams ?? []);
  const menu = !terminal && (canManage || owner);

  async function run(action: 'check' | 'disconnect') {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setMessage('');
    try {
      const result = await changeConnection(organizationId, connection, action);
      setMessage(
        action === 'disconnect'
          ? m.connections_disconnected()
          : result.status === 'active'
            ? m.connections_validated()
            : m.connections_validation_incomplete(),
      );
      setDialog(null);
    } catch (error) {
      setMessage(connectionError(error));
    } finally {
      await refresh();
      lock.current = false;
      setPending(false);
    }
  }

  async function changeWriteMode() {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setMessage('');
    try {
      await changeConnectionWriteMode(
        organizationId,
        connection,
        connection.writeMode === 'observe_only' ? null : 'observe_only',
      );
      setMessage(m.settings_command_saved());
    } catch (error) {
      setMessage(connectionError(error));
    } finally {
      await refresh();
      lock.current = false;
      setPending(false);
    }
  }

  async function rename(label: string) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setMessage('');
    try {
      await renameConnection(organizationId, connection, label);
      setDialog(null);
    } catch (error) {
      setMessage(connectionError(error));
    } finally {
      await refresh();
      lock.current = false;
      setPending(false);
    }
  }

  return (
    <Card
      as="article"
      id={`connection-${connection.id}`}
      className="connection"
      aria-label={connection.label}
      data-terminal={terminal || undefined}
      data-attention={state.attention || undefined}
      tabIndex={-1}
    >
      <header className="connection-header">
        <div className="connection-title">
          <h3>{connection.label}</h3>
          <p>
            <span>{connectionKindName(connection.target.kind)}</span>
            {target.primary ? (
              <span className="connection-target">{target.primary}</span>
            ) : null}
          </p>
        </div>
        <StatePill state={state.state}>{state.label}</StatePill>
        {menu ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={pending}
                  aria-label={m.connections_actions({
                    connection: connection.label,
                  })}
                />
              }
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="connection-menu">
              {canManage ? (
                <DropdownMenuItem
                  onClick={() => {
                    setMessage('');
                    setDialog('rename');
                  }}
                >
                  <Pencil aria-hidden="true" />
                  {m.connections_rename()}
                </DropdownMenuItem>
              ) : null}
              {owner ? (
                <DropdownMenuItem onClick={() => void changeWriteMode()}>
                  {connection.writeMode === 'observe_only' ? (
                    <PenLine aria-hidden="true" />
                  ) : (
                    <Eye aria-hidden="true" />
                  )}
                  {connection.writeMode === 'observe_only'
                    ? m.connections_write_mode_inherit()
                    : m.connections_write_mode_observe()}
                </DropdownMenuItem>
              ) : null}
              {owner && canManage ? <DropdownMenuSeparator /> : null}
              {canManage ? (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    setMessage('');
                    setDialog('disconnect');
                  }}
                >
                  <Unplug aria-hidden="true" />
                  {m.connections_disconnect()}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>
      {note && state.attention && appAvailable ? (
        <Alert tone={connection.status === 'pending' ? 'info' : 'warning'}>
          {note}
        </Alert>
      ) : note ? (
        <p className="connection-note">{note}</p>
      ) : null}
      {!terminal ? (
        <dl className="connection-facts">
          {connection.coverage ? (
            <div>
              <dt>{m.connections_fact_last_read()}</dt>
              <dd>
                {connection.coverage.lastObservedAt ? (
                  <RelativeTime value={connection.coverage.lastObservedAt} />
                ) : (
                  m.connections_fact_not_yet()
                )}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{m.connections_fact_access()}</dt>
            <dd>{accessLevels[access.level]()}</dd>
          </div>
          {writes ? (
            <div>
              <dt>{m.connections_fact_writes()}</dt>
              <dd>{writes}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {streams.length ? (
        <section
          className="connection-data"
          aria-labelledby={`connection-${connection.id}-data`}
        >
          <div className="connection-subheading">
            <h4 id={`connection-${connection.id}-data`}>
              {m.connections_data_title()}
            </h4>
            {sync ? (
              <Link
                to="/app/$organizationId/sync"
                params={{ organizationId }}
                search={{ connection: connection.id }}
              >
                {m.connections_card_view_sync()}
              </Link>
            ) : null}
          </div>
          <ul className="connection-streams">
            {streams.map((stream) => {
              const label =
                stream.recordType in recordTypes
                  ? recordTypes[stream.recordType as SyncRecordType].title
                  : operatorCodeLabel(`${stream.recordType}.read`);
              const streamId = sync?.recordTypes.find(
                (item) => item.recordType === stream.recordType,
              )?.stream?.id;

              return (
                <li
                  key={stream.recordType}
                  data-failed={stream.lastError ? true : undefined}
                >
                  {streamId ? (
                    <Link
                      className="connection-stream-name"
                      to="/app/$organizationId/sync"
                      params={{ organizationId }}
                      search={{ stream: streamId }}
                      aria-label={m.connections_open_sync_label({
                        type: label,
                      })}
                    >
                      {label}
                    </Link>
                  ) : (
                    <span className="connection-stream-name">{label}</span>
                  )}
                  <span className="connection-stream-time">
                    {stream.lastSuccessfulAt ? (
                      <RelativeTime value={stream.lastSuccessfulAt} />
                    ) : (
                      m.connections_fact_not_yet()
                    )}
                  </span>
                  {stream.lastError ? (
                    <span className="connection-stream-error">
                      {operatorCodeLabel(stream.lastError)}
                    </span>
                  ) : null}
                  {stream.issueIds.map((exceptionId) => (
                    <Link
                      key={exceptionId}
                      className="connection-stream-issue"
                      to="/app/$organizationId/exceptions/$exceptionId/detail"
                      params={{ organizationId, exceptionId }}
                    >
                      {m.connections_open_issue()}
                    </Link>
                  ))}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {!terminal && connection.permissions.length ? (
        <Disclosure
          className="connection-permissions"
          open={
            connection.status === 'degraded' ||
            (connection.status === 'active' &&
              appAvailable &&
              access.unavailable.length > 0) ||
            undefined
          }
        >
          <summary>
            <ShieldCheck size={14} aria-hidden="true" />
            <span>{m.connections_permissions_title()}</span>
            <span className="connection-permissions-count">
              {[
                access.reads.length
                  ? m.connections_permissions_reads_count({
                      count: access.reads.length,
                    })
                  : null,
                access.changes.length
                  ? m.connections_permissions_changes_count({
                      count: access.changes.length,
                    })
                  : null,
                access.unavailable.length
                  ? m.connections_permissions_unavailable_count({
                      count: access.unavailable.length,
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </summary>
          <div className="connection-permission-groups">
            {access.reads.length ? (
              <PermissionGroup
                title={m.connections_permissions_reads()}
                items={access.reads}
                enabled
              />
            ) : null}
            {access.changes.length ? (
              <PermissionGroup
                title={m.connections_permissions_changes()}
                items={access.changes}
                enabled
              />
            ) : null}
            {access.unavailable.length ? (
              <PermissionGroup
                title={m.connections_permissions_unavailable()}
                description={
                  !appAvailable
                    ? m.connections_permissions_unavailable_app()
                    : connection.status === 'active'
                      ? m.connections_permissions_unavailable_denied({
                          system,
                        })
                      : m.connections_permissions_unavailable_validation()
                }
                items={access.unavailable}
              />
            ) : null}
          </div>
        </Disclosure>
      ) : null}
      <Disclosure className="connection-details">
        <summary>{m.connections_details_title()}</summary>
        <dl>
          {target.fields.map((field) => (
            <div key={field.key}>
              <dt>{field.label}</dt>
              <dd className="connection-target">{field.value}</dd>
            </div>
          ))}
          <div>
            <dt>{m.connections_details_added()}</dt>
            <dd>
              <WorkspaceDate value={connection.createdAt} />
            </dd>
          </div>
          <div>
            <dt>{m.connections_details_id()}</dt>
            <dd className="connection-target">{connection.id}</dd>
          </div>
        </dl>
      </Disclosure>
      {canReadHistory ? (
        <ConnectionHistory
          organizationId={organizationId}
          connection={connection}
        />
      ) : null}
      {canManage && (canCheck || canOpenSettings) ? (
        <div className="connection-actions">
          {revoked || terminal ? (
            canOpenSettings ? (
              <Button
                variant={revoked ? 'default' : 'outline'}
                disabled={pending}
                onClick={() => setDialog('settings')}
              >
                <RotateCcw aria-hidden="true" />
                {m.connections_reconnect()}
              </Button>
            ) : null
          ) : (
            <>
              {canCheck ? (
                <Button
                  variant={urgent ? 'default' : 'outline'}
                  disabled={pending}
                  onClick={() => void run('check')}
                >
                  <ShieldCheck aria-hidden="true" />
                  {pending
                    ? m.connections_validating()
                    : m.connections_validate()}
                </Button>
              ) : null}
              {canOpenSettings ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => setDialog('settings')}
                >
                  {m.connections_settings()}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <p role="status" className="connection-feedback">
        {dialog === 'disconnect' || dialog === 'rename' ? '' : message}
      </p>
      {canManage && !terminal ? (
        <RenameDialog
          key={`${connection.id}:${connection.version}:${dialog === 'rename'}`}
          open={dialog === 'rename'}
          label={connection.label}
          pending={pending}
          error={dialog === 'rename' ? message : ''}
          close={() => {
            if (!pending) setDialog(null);
          }}
          save={(label) => void rename(label)}
        />
      ) : null}
      {canOpenSettings && canManage ? (
        <Dialog
          open={dialog === 'settings'}
          onOpenChange={(open) => setDialog(open ? 'settings' : null)}
        >
          <DialogContent className="connection-dialog">
            <DialogTitle>
              {revoked || terminal
                ? m.connections_reconnect_title({
                    connection: connection.label,
                  })
                : m.connections_settings_title({
                    connection: connection.label,
                  })}
            </DialogTitle>
            <DialogDescription>
              {m.connections_settings_description()}
            </DialogDescription>
            {dialog === 'settings' ? (
              <AppExtension
                appId={connection.appId!}
                organizationId={organizationId}
                slot="settings"
                connection={connection}
                done={async () => {
                  setDialog(null);
                  await refresh();
                }}
              />
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
      {canManage && !terminal ? (
        <Dialog
          open={dialog === 'disconnect'}
          onOpenChange={(open) => {
            if (!open && !pending) setDialog(null);
          }}
        >
          <DialogContent className="connection-dialog">
            <DialogTitle>
              {m.connections_disconnect_title({
                connection: connection.label,
              })}
            </DialogTitle>
            <DialogDescription>
              {m.connections_disconnect_description({ system })}
            </DialogDescription>
            {message ? (
              <p role="alert" className="connection-feedback">
                {message}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => setDialog(null)}
              >
                {m.common_cancel()}
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => void run('disconnect')}
              >
                {pending
                  ? m.connections_disconnecting()
                  : m.connections_disconnect_confirm()}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}

/** Asks for a connection's new name; keeps the typed name when saving fails. */
function RenameDialog({
  open,
  label,
  pending,
  error,
  close,
  save,
}: {
  open: boolean;
  label: string;
  pending: boolean;
  error: string;
  close: () => void;
  save: (label: string) => void;
}) {
  const [value, setValue] = useState(label);
  const id = useId();
  const name = value.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="connection-dialog">
        <DialogTitle>{m.connections_rename_title()}</DialogTitle>
        <DialogDescription>
          {m.connections_rename_description()}
        </DialogDescription>
        <form
          className="connection-rename"
          onSubmit={(event) => {
            event.preventDefault();
            if (name && name !== label) save(name);
          }}
        >
          <Field>
            <FieldLabel htmlFor={id}>{m.connections_rename_label()}</FieldLabel>
            <Input
              id={id}
              value={value}
              maxLength={120}
              required
              autoComplete="off"
              disabled={pending}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
          {error ? (
            <p role="alert" className="connection-feedback">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={close}
            >
              {m.common_cancel()}
            </Button>
            <Button type="submit" disabled={pending || !name || name === label}>
              {pending ? m.common_saving() : m.connections_rename_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Capabilities of one kind, each with its people-facing name. */
function PermissionGroup({
  title,
  description,
  items,
  enabled = false,
}: {
  title: string;
  description?: string;
  items: readonly InstalledConnection['permissions'][number][];
  enabled?: boolean;
}) {
  return (
    <div className="connection-permission-group" data-enabled={enabled}>
      <h4>{title}</h4>
      {description ? <p>{description}</p> : null}
      <ul>
        {items.map((item) => (
          <li key={item}>
            {enabled ? (
              <Check size={13} aria-hidden="true" />
            ) : (
              <Minus size={13} aria-hidden="true" />
            )}
            {capabilities[item]}
          </li>
        ))}
      </ul>
    </div>
  );
}
