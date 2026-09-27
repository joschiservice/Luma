import { type InstalledConnection } from '@luma/api-contract';
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
import { Check, Minus, ShieldCheck, Unplug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { AppExtension } from '../apps/extension';
import { changeConnection, connectionError } from './data';
import { capabilities, statuses } from './presentation';
import { ProviderIcon } from './provider-icon';

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
}: {
  connection: InstalledConnection;
  organizationId: string;
  canManage: boolean;
  appAvailable?: boolean;
  refresh: () => Promise<void>;
}) {
  const [dialog, setDialog] = useState<'settings' | 'disconnect' | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (window.location.hash === `#connection-${connection.id}`) {
      const element = document.getElementById(`connection-${connection.id}`);
      element?.scrollIntoView({ block: 'center' });
      element?.focus({ preventScroll: true });
    }
  }, [connection.id]);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const terminal =
    connection.status === 'disconnected' || connection.status === 'revoked';
  const permitted =
    connection.status === 'active' && appAvailable
      ? connection.permissions.filter((p) => connection.granted.includes(p))
      : [];
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
          ? 'Connection disconnected.'
          : result.status === 'active'
            ? 'Access validated.'
            : 'Validation did not confirm all requested permissions. Check provider access and credentials.',
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
            <p className="eyebrow">{connection.target.kind}</p>
            <CardTitle as="h3">{connection.label}</CardTitle>
          </div>
        </div>
        <Badge
          tone={
            connection.status === 'active'
              ? 'success'
              : terminal
                ? 'neutral'
                : 'warning'
          }
        >
          {statuses[connection.status]}
        </Badge>
      </CardHeader>
      <p className="connection-target">{target}</p>
      <p className="connection-description">
        {!appAvailable
          ? 'This app is unavailable in the workspace. Historical connection data remains accessible.'
          : terminal
            ? 'Access stopped. Add a connection to reconnect.'
            : connection.status === 'active'
              ? 'Credentials and requested permissions validated. Observation freshness is unknown.'
              : 'Validate access or open connection settings to restore access.'}
      </p>
      <div className="connection-access">
        <h4>
          <ShieldCheck size={15} aria-hidden="true" />
          {permitted.some((p) => p.endsWith('.write'))
            ? 'Read and write access'
            : permitted.length
              ? 'Read-only access'
              : 'No capabilities enabled'}
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
                  ? 'Permitted'
                  : connection.granted.includes(permission) && !terminal
                    ? 'Verified · not enabled'
                    : 'Not enabled'}
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
            <DialogTrigger render={<Button variant="outline" />}>
              Connection settings
            </DialogTrigger>
            <DialogContent className="connection-dialog">
              <DialogTitle>Connection settings</DialogTitle>
              <DialogDescription>
                Manage this connection through its app.
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
            (!connection.management ||
              connection.management.includes('check')) ? (
              <Button disabled={pending} onClick={() => void run('check')}>
                <ShieldCheck size={14} aria-hidden="true" />
                {pending ? 'Please wait…' : 'Validate access'}
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
                <Unplug size={14} aria-hidden="true" /> Disconnect
              </DialogTrigger>
              <DialogContent className="connection-dialog">
                <DialogTitle>Disconnect {connection.label}?</DialogTitle>
                <DialogDescription>
                  Luma will delete stored credentials and stop new reads and
                  writes. Requests already sent may finish. This does not revoke
                  the provider token; revoke it with the provider if needed.
                </DialogDescription>
                <div className="connection-actions">
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => setDialog(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={pending}
                    onClick={() => void run('disconnect')}
                  >
                    {pending ? 'Disconnecting…' : 'Confirm disconnect'}
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
