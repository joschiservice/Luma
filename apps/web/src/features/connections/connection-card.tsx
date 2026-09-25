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
import {
  Check,
  KeyRound,
  Minus,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { useRef, useState } from 'react';

import { changeConnection, connectionError } from './data';
import { capabilities, providers, statuses } from './presentation';
import { ProviderIcon } from './provider-icon';
import { SetupForm } from './setup-form';
import { ShopifyForm } from './shopify';

/**
 * Shows a connection's verified permissions and management actions, refreshing the list
 * after changes.
 */
export function ConnectionCard({
  connection,
  organizationId,
  canManage,
  refresh,
}: {
  connection: InstalledConnection;
  organizationId: string;
  canManage: boolean;
  refresh: () => Promise<void>;
}) {
  const [dialog, setDialog] = useState<'rotate' | 'disconnect' | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const terminal =
    connection.status === 'disconnected' || connection.status === 'revoked';
  const permitted =
    connection.status === 'active'
      ? connection.permissions.filter((p) => connection.granted.includes(p))
      : [];
  const target =
    connection.target.kind === 'shopify'
      ? connection.target.shop
      : connection.target.kind === 'jtl-cloud'
        ? connection.target.jtlTenantId
        : connection.target.baseUrl;

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
    >
      <CardHeader>
        <div className="connection-identity">
          <ProviderIcon provider={connection.target.kind} />
          <div>
            <p className="eyebrow">{providers[connection.target.kind]}</p>
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
        {terminal
          ? connection.target.kind === 'shopify'
            ? 'Access stopped. Reconnect Shopify to restore reads.'
            : 'Access stopped. Create a new installation to reconnect.'
          : connection.status === 'active'
            ? 'Credentials and requested permissions validated. Observation freshness is unknown.'
            : connection.status === 'pending'
              ? 'Validate access before Luma can use this connection.'
              : connection.target.kind === 'shopify'
                ? 'Confirm the app permissions and reconnect Shopify to restore access.'
                : 'Check missing provider scopes, expired credentials or provider availability. Replace credentials if needed, then validate again.'}
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
        {canManage && connection.target.kind === 'shopify' ? (
          <Dialog>
            <DialogTrigger render={<Button variant="outline" />}>
              <RefreshCw size={14} aria-hidden="true" /> Reconnect Shopify
            </DialogTrigger>
            <DialogContent className="connection-dialog">
              <DialogTitle>Reconnect Shopify</DialogTitle>
              <DialogDescription>
                Approve access again to restore this connection.
              </DialogDescription>
              <ShopifyForm
                organizationId={organizationId}
                shop={connection.target.shop}
                label={connection.label}
              />
            </DialogContent>
          </Dialog>
        ) : null}
        {canManage && !terminal ? (
          <div className="connection-actions">
            {connection.target.kind !== 'shopify' ? (
              <Button disabled={pending} onClick={() => void run('check')}>
                <ShieldCheck size={14} aria-hidden="true" />
                {pending ? 'Please wait…' : 'Validate access'}
              </Button>
            ) : null}
            {connection.target.kind !== 'shopify' ? (
              <Dialog
                open={dialog === 'rotate'}
                onOpenChange={(open) => setDialog(open ? 'rotate' : null)}
              >
                <DialogTrigger
                  render={<Button variant="outline" disabled={pending} />}
                >
                  <KeyRound size={14} aria-hidden="true" /> Replace credentials
                </DialogTrigger>
                <DialogContent className="connection-dialog">
                  <DialogTitle>Replace credentials</DialogTitle>
                  <DialogDescription>
                    Current credentials will stop working in Luma. Reads and
                    writes pause until the replacement passes validation. The
                    account and endpoint stay the same.
                  </DialogDescription>
                  <SetupForm
                    provider={connection.target.kind}
                    organizationId={organizationId}
                    connection={connection}
                    done={async () => {
                      setDialog(null);
                      setMessage(
                        'Credentials replaced. Validate access to restore capabilities.',
                      );
                      await refresh();
                    }}
                  />
                </DialogContent>
              </Dialog>
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
                  {connection.target.kind === 'shopify'
                    ? 'Use Reconnect Shopify to restore access.'
                    : 'Reconnecting requires a new installation.'}
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
