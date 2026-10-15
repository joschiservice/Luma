import {
  type InstalledConnection,
  type SyncConnectionView,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@luma/ui/components/primitives/dialog';
import { StateDot } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { connectionHealthLabel } from '@luma/ui/lib/connection-health';
import { operatorCodeLabel } from '@luma/ui/lib/operator-code';
import { Link } from '@tanstack/react-router';
import { Check, Minus, ShieldCheck, Unplug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  changeConnection,
  changeConnectionWriteMode,
  connectionError,
} from '../../kit/connections/data';
import {
  capabilities,
  connectionKindName,
  connectionSystem,
  statuses,
} from '../../kit/connections/presentation';
import { ProviderIcon } from '../../kit/connections/provider-icon';
import { connectionSummary } from '../sync/presentation';
import { AppExtension } from './extension';

/**
 * Shows a connection's verified permissions and management actions, refreshing the list
 * after changes.
 */
export function ConnectionCard({
  connection,
  organizationId,
  canManage,
  appAvailable = true,
  refresh,
  sync,
  syncAsOf,
  owner = false,
  workspaceWriteMode,
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
  syncAsOf?: string | undefined;
}) {
  const observeOnly =
    connection.writeMode === 'observe_only' ||
    workspaceWriteMode === 'observe_only';
  const [dialog, setDialog] = useState<'settings' | 'disconnect' | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (window.location.hash === `#connection-${connection.id}`) {
      const element = document.getElementById(`connection-${connection.id}`);
      element
        ?.closest('.connections-section')
        ?.scrollIntoView({ block: 'start' });
      element?.focus({ preventScroll: true });
    }
  }, [connection.id]);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const summary =
    sync && syncAsOf && appAvailable ? connectionSummary(sync, syncAsOf) : null;
  // People disconnect; only providers revoke, and a revoked connection can be reconnected.
  const terminal = connection.status === 'disconnected';
  const revoked = connection.status === 'revoked';
  const permitted =
    connection.status === 'active' && appAvailable
      ? connection.permissions.filter((p) => connection.granted.includes(p))
      : [];
  const system = connectionSystem(connection.target.kind);
  const target = Object.entries(connection.target)
    .filter(([key]) => key !== 'kind')
    .map(([, value]) => value)
    .join(' · ');

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

  return (
    <Card
      as="article"
      id={`connection-${connection.id}`}
      className="connection-card"
      aria-label={connection.label}
      tabIndex={-1}
    >
      <CardHeader>
        <div className="connection-identity">
          <ProviderIcon provider={connection.target.kind} />
          <div>
            <p className="eyebrow">
              {connectionKindName(connection.target.kind)}
            </p>
            <CardTitle as="h3">{connection.label}</CardTitle>
          </div>
        </div>
        <Badge
          tone={
            connection.coverage?.health === 'healthy' ||
            (!connection.coverage && connection.status === 'active')
              ? 'success'
              : terminal
                ? 'neutral'
                : 'warning'
          }
        >
          {connection.coverage?.health
            ? connectionHealthLabel(connection.coverage.health).label
            : statuses[connection.status]}
        </Badge>
      </CardHeader>
      <p>
        {observeOnly
          ? m.issues_observe_only_title()
          : workspaceWriteMode
            ? m.settings_write_mode_enabled()
            : null}
      </p>
      {owner ? (
        <Button
          variant="outline"
          disabled={pending || terminal}
          onClick={async () => {
            if (lock.current) return;
            lock.current = true;
            setPending(true);
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
          }}
        >
          {connection.writeMode === 'observe_only'
            ? m.connections_write_mode_inherit()
            : m.issues_observe_only_title()}
        </Button>
      ) : null}
      <p className="connection-target">{target}</p>
      <p className="connection-description">
        {!appAvailable
          ? m.connections_card_app_unavailable()
          : terminal
            ? m.connections_card_disconnected()
            : revoked
              ? m.connections_card_revoked({ system })
              : connection.status === 'active'
                ? m.connections_card_active()
                : m.connections_card_needs_validation()}
      </p>
      {summary ? (
        <p className="connection-sync">
          <StateDot state={summary.state} />
          <span>
            {summary.text}{' '}
            <Link to="/app/$organizationId/sync" params={{ organizationId }}>
              {m.connections_card_view_sync()}
            </Link>
          </span>
        </p>
      ) : null}
      {connection.coverage?.streams?.map((stream) => (
        <section key={stream.recordType}>
          <strong>
            {operatorCodeLabel(
              `${stream.recordType === 'fulfillments' ? 'fulfillment' : stream.recordType}.read`,
            )}
          </strong>
          <p>
            {m.connections_last_success()} ·{' '}
            {stream.lastSuccessfulAt ? (
              <WorkspaceDate value={stream.lastSuccessfulAt} />
            ) : (
              m.common_not_reported()
            )}
          </p>
          {stream.lastError ? (
            <p>{operatorCodeLabel(stream.lastError)}</p>
          ) : null}
          {stream.issueIds.map((exceptionId) => (
            <Link
              key={exceptionId}
              to="/app/$organizationId/exceptions/$exceptionId/detail"
              params={{ organizationId, exceptionId }}
            >
              {m.connections_open_issue()}
            </Link>
          ))}
        </section>
      ))}
      <div className="connection-access">
        <h4>
          <ShieldCheck size={15} aria-hidden="true" />
          {permitted.some((p) => p.endsWith('.write'))
            ? m.connections_access_read_write()
            : permitted.length
              ? m.connections_access_read_only()
              : m.connections_access_none()}
        </h4>
        <ul className="connection-capabilities">
          {connection.permissions.map((permission) => (
            <li key={permission} data-enabled={permitted.includes(permission)}>
              <span className="connection-capability-name">
                {permitted.includes(permission) ? (
                  <Check size={13} aria-hidden="true" />
                ) : (
                  <Minus size={13} aria-hidden="true" />
                )}
                {capabilities[permission]}
              </span>
              <span>
                {permitted.includes(permission)
                  ? m.connections_permission_permitted()
                  : connection.granted.includes(permission) && !terminal
                    ? m.connections_permission_granted()
                    : m.connections_permission_not_enabled()}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="connection-management">
        {canManage && appAvailable && connection.appId ? (
          <Dialog
            open={dialog === 'settings'}
            onOpenChange={(open) => setDialog(open ? 'settings' : null)}
          >
            <DialogTrigger
              render={<Button variant={revoked ? 'default' : 'outline'} />}
            >
              {revoked ? m.connections_reconnect() : m.connections_settings()}
            </DialogTrigger>
            <DialogContent className="connection-dialog">
              <DialogTitle>
                {revoked
                  ? m.connections_reconnect_title({
                      connection: connection.label,
                    })
                  : m.connections_settings()}
              </DialogTitle>
              <DialogDescription>
                {m.connections_settings_description()}
              </DialogDescription>
              <AppExtension
                appId={connection.appId}
                organizationId={organizationId}
                slot="settings"
                connection={connection}
                done={async () => {
                  setDialog(null);
                  await refresh();
                }}
              />
            </DialogContent>
          </Dialog>
        ) : null}
        {canManage && !terminal ? (
          <div className="connection-actions">
            {appAvailable &&
            !revoked &&
            (!connection.management ||
              connection.management.includes('check')) ? (
              <Button disabled={pending} onClick={() => void run('check')}>
                <ShieldCheck size={14} aria-hidden="true" />
                {pending
                  ? m.connections_validating()
                  : m.connections_validate()}
              </Button>
            ) : null}
            <Dialog
              open={dialog === 'disconnect'}
              onOpenChange={(open) => {
                if (!pending) {
                  if (open) setMessage('');
                  setDialog(open ? 'disconnect' : null);
                }
              }}
            >
              <DialogTrigger
                render={<Button variant="ghost" disabled={pending} />}
              >
                <Unplug size={14} aria-hidden="true" />{' '}
                {m.connections_disconnect()}
              </DialogTrigger>
              <DialogContent className="connection-dialog">
                <DialogTitle>
                  {m.connections_disconnect_title({
                    connection: connection.label,
                  })}
                </DialogTitle>
                <DialogDescription>
                  {m.connections_disconnect_description({ system })}
                </DialogDescription>
                <div className="connection-actions">
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => setDialog(null)}
                  >
                    {m.common_cancel()}
                  </Button>
                  <Button
                    disabled={pending}
                    onClick={() => void run('disconnect')}
                  >
                    {pending
                      ? m.connections_disconnecting()
                      : m.connections_disconnect_confirm()}
                  </Button>
                </div>
                <p role="status">{message}</p>
              </DialogContent>
            </Dialog>
          </div>
        ) : null}
      </div>
      <p role="status">{message}</p>
    </Card>
  );
}
