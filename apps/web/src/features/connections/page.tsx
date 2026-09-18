import { useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import {
  installationInput,
  installationCredentials,
  type InstalledConnection,
  type InstallationInput,
  type InstallationCapability,
} from '@luma/api-contract';
import { Button } from '@luma/ui/button';
import { Input } from '@luma/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@luma/ui/components/dialog';
import { contextOptions, IdentityError } from '../identity/data';
import { SignInRedirect } from '../identity/common';
import {
  changeConnection,
  connectionError,
  connectionsOptions,
  installConnection,
} from './data';

const providers = {
  shopify: 'Shopify',
  'jtl-cloud': 'JTL Cloud',
  'jtl-onprem': 'JTL-Wawi on-premise',
} as const;
type Provider = keyof typeof providers;
const reads = [
  'orders.read',
  'products.read',
  'inventory.read',
  'fulfillment.read',
] as const;
const capabilities: Record<InstallationCapability, string> = {
  'orders.read': 'Read orders',
  'products.read': 'Read products',
  'inventory.read': 'Read inventory',
  'fulfillment.read': 'Read fulfillment',
  'orders.shipping-method.read': 'Read shipping method',
  'orders.shipping-method.write': 'Correct shipping method',
};
const statuses = {
  pending: 'Awaiting validation',
  active: 'Validated',
  degraded: 'Needs attention',
  disconnected: 'Disconnected',
  revoked: 'Revoked',
};

export function ConnectionsPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  return <Connections key={organizationId} organizationId={organizationId} />;
}
export function Connections({ organizationId }: { organizationId: string }) {
  const access = useQuery(contextOptions(organizationId));
  const query = useQuery(connectionsOptions(organizationId));
  const client = useQueryClient();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [message, setMessage] = useState('');
  const canManage =
    access.data?.actor.role === 'owner' || access.data?.actor.role === 'admin';
  const refresh = async () => {
    await client.invalidateQueries({
      queryKey: connectionsOptions(organizationId).queryKey,
    });
  };
  const error = access.error ?? query.error;
  if (error instanceof IdentityError && error.status === 401)
    return <SignInRedirect />;
  return (
    <div className="connections-page">
      <p className="eyebrow">Exception Desk / Your systems</p>
      <h1>Connections</h1>
      <p className="desk-intro">
        Connect your commerce systems. See what Luma is permitted to read and
        change.
      </p>
      <section
        aria-labelledby="installed-title"
        className="connections-section"
      >
        <div className="connections-heading">
          <h2 id="installed-title">Installed in this workspace</h2>
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void refresh()}
          >
            {query.isFetching ? 'Refreshing…' : 'Refresh list'}
          </Button>
        </div>
        {error ? (
          <p role="alert">{connectionError(error)}</p>
        ) : query.isPending || access.isPending ? (
          <p role="status">Loading connections…</p>
        ) : (
          <>
            {!canManage ? (
              <p className="connection-notice">
                You can view connections. An owner or admin must manage setup
                and credentials.
              </p>
            ) : null}
            {query.data?.length === 0 ? (
              <div className="connection-empty">
                <h3>No connections yet</h3>
                <p>Choose a system below to start observing your operations.</p>
              </div>
            ) : (
              <div className="connection-list">
                {query.data?.map((connection) => (
                  <ConnectionCard
                    key={connection.id}
                    connection={connection}
                    organizationId={organizationId}
                    canManage={canManage}
                    refresh={refresh}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>
      {!error && !query.isPending && !access.isPending ? (
        <section aria-labelledby="setup-title" className="connections-section">
          <p className="eyebrow">Add a system</p>
          <h2 id="setup-title">Available setup options</h2>
          <p>These are supported providers, not installed connections.</p>
          <div className="connection-providers">
            {(Object.keys(providers) as Provider[]).map((kind) => (
              <article key={kind}>
                <h3>{providers[kind]}</h3>
                <p>
                  {kind === 'shopify'
                    ? 'Read orders, products, inventory and fulfillment from your shop.'
                    : 'Read commerce data and optionally permit shipping-method corrections.'}
                </p>
                <Button
                  variant="outline"
                  disabled={!canManage}
                  onClick={() => setProvider(kind)}
                >
                  Set up {providers[kind]}
                </Button>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <p role="status">{message}</p>
      <Dialog
        open={provider !== null && canManage && !error}
        onOpenChange={(open) => {
          if (!open) setProvider(null);
        }}
      >
        <DialogContent className="connection-dialog">
          <DialogTitle>
            Connect {provider ? providers[provider] : 'system'}
          </DialogTitle>
          <DialogDescription>
            Use credentials issued for this account. Luma stores them securely
            and never displays them again.
          </DialogDescription>
          {provider ? (
            <SetupForm
              key={provider}
              provider={provider}
              organizationId={organizationId}
              done={async () => {
                setProvider(null);
                setMessage(
                  'Connection saved. Validate access to enable its capabilities.',
                );
                await refresh();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
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
    <article className="connection-card" aria-label={connection.label}>
      <div className="connections-heading">
        <div>
          <p className="eyebrow">{providers[connection.target.kind]}</p>
          <h3>{connection.label}</h3>
        </div>
        <span
          className={`connection-status connection-status-${connection.status}`}
        >
          {statuses[connection.status]}
        </span>
      </div>
      <p className="connection-target">{target}</p>
      <p>
        {terminal
          ? 'Access stopped. Create a new installation to reconnect.'
          : connection.status === 'active'
            ? 'Credentials and requested permissions validated. Observation freshness is unknown.'
            : connection.status === 'pending'
              ? 'Validate access before Luma can use this connection.'
              : 'Check missing provider scopes, expired credentials or provider availability. Replace credentials if needed, then validate again.'}
      </p>
      <h4>
        {permitted.some((p) => p.endsWith('.write'))
          ? 'Read and write access'
          : permitted.length
            ? 'Read-only access'
            : 'No capabilities enabled'}
      </h4>
      <ul className="connection-capabilities">
        {connection.permissions.map((permission) => (
          <li key={permission}>
            {capabilities[permission]}{' '}
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
      {canManage && !terminal ? (
        <div className="connection-actions">
          <Button disabled={pending} onClick={() => void run('check')}>
            {pending ? 'Please wait…' : 'Validate access'}
          </Button>
          <Dialog
            open={dialog === 'rotate'}
            onOpenChange={(open) => setDialog(open ? 'rotate' : null)}
          >
            <DialogTrigger
              render={<Button variant="outline" disabled={pending} />}
            >
              Replace credentials
            </DialogTrigger>
            <DialogContent className="connection-dialog">
              <DialogTitle>Replace credentials</DialogTitle>
              <DialogDescription>
                Current credentials will stop working in Luma. Reads and writes
                pause until the replacement passes validation. The account and
                endpoint stay the same.
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
          <Dialog
            open={dialog === 'disconnect'}
            onOpenChange={(open) => {
              if (!pending) setDialog(open ? 'disconnect' : null);
            }}
          >
            <DialogTrigger
              render={<Button variant="ghost" disabled={pending} />}
            >
              Disconnect
            </DialogTrigger>
            <DialogContent>
              <DialogTitle>Disconnect {connection.label}?</DialogTitle>
              <DialogDescription>
                Luma will delete stored credentials and stop new reads and
                writes. Requests already sent may finish. This does not revoke
                the provider token; revoke it with the provider if needed.
                Reconnecting requires a new installation.
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
      <p role="status">{message}</p>
    </article>
  );
}

function SetupForm({
  provider,
  organizationId,
  connection,
  done,
}: {
  provider: Provider;
  organizationId: string;
  connection?: InstalledConnection;
  done: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const result = useRef<HTMLParagraphElement>(null);
  const [invalid, setInvalid] = useState<string[]>([]);
  const form = useForm({
    defaultValues: {
      label: '',
      shop: '',
      jtlTenantId: '',
      baseUrl: '',
      appId: '',
      appVersion: '',
      token: '',
      challengeCode: '',
      write: false,
    },
    onSubmit: async ({ value }) => {
      if (lock.current || uncertain) return;
      const credentials = {
        token: value.token,
        ...(provider === 'jtl-onprem'
          ? { challengeCode: value.challengeCode }
          : {}),
      };
      const target: InstallationInput['target'] =
        provider === 'shopify'
          ? { kind: provider, shop: value.shop.trim().toLowerCase() }
          : provider === 'jtl-cloud'
            ? { kind: provider, jtlTenantId: value.jtlTenantId.trim() }
            : {
                kind: provider,
                baseUrl: value.baseUrl.trim(),
                appId: value.appId.trim(),
                appVersion: value.appVersion.trim(),
              };
      const input = {
        label: value.label.trim(),
        target,
        credentials,
        permissions: [
          ...reads,
          ...(value.write
            ? ([
                'orders.shipping-method.read',
                'orders.shipping-method.write',
              ] as const)
            : []),
        ],
      };
      const parsed = connection
        ? installationCredentials.safeParse(credentials)
        : installationInput.safeParse(input);
      if (!parsed.success) {
        setInvalid(
          parsed.error.issues.map((issue) => String(issue.path.at(-1) ?? '')),
        );
        setMessage(
          'Check all fields. Use a myshopify.com hostname, a valid cloud tenant ID, or an HTTPS API URL ending in /. Credentials are required; on-premise also requires a challenge code.',
        );
        result.current?.focus();
        return;
      }
      setInvalid([]);
      lock.current = true;
      setPending(true);
      setMessage('');
      try {
        // Keep secrets out of Query's mutation cache and discard them after every request.
        if (connection)
          await changeConnection(
            organizationId,
            connection,
            'rotate',
            credentials,
          );
        else
          await installConnection(
            organizationId,
            installationInput.parse(input),
          );
        await done();
      } catch (error) {
        setMessage(connectionError(error));
        setUncertain(
          !(error instanceof IdentityError) ||
            error.status >= 500 ||
            error.status === 409,
        );
      } finally {
        form.setFieldValue('token', '');
        form.setFieldValue('challengeCode', '');
        lock.current = false;
        setPending(false);
        requestAnimationFrame(() => result.current?.focus());
      }
    },
  });
  const fields = connection
    ? []
    : provider === 'shopify'
      ? (['label', 'shop'] as const)
      : provider === 'jtl-cloud'
        ? (['label', 'jtlTenantId'] as const)
        : (['label', 'baseUrl', 'appId', 'appVersion'] as const);
  const labels = {
    label: 'Connection name',
    shop: 'Shop hostname',
    jtlTenantId: 'JTL Cloud tenant ID',
    baseUrl: 'HTTPS API URL',
    appId: 'App ID',
    appVersion: 'App version',
    token: 'Access token',
    challengeCode: 'Challenge code',
  };
  return (
    <form
      autoComplete="off"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <p className="field-help">
        {provider === 'shopify'
          ? 'Provide an Admin API token with read_orders, read_products, read_inventory and fulfillment access for the requested data. Older orders need read_all_orders where applicable.'
          : provider === 'jtl-cloud'
            ? 'Use the tenant ID and access token from your JTL Cloud installation. Grant access to orders, products, inventory and fulfillment.'
            : 'Register your app with JTL-Wawi. Use its token and challenge code. Your administrator must approve the API network destination.'}
      </p>
      {[
        ...fields,
        'token',
        ...(provider === 'jtl-onprem' ? (['challengeCode'] as const) : []),
      ].map((name) => (
        <form.Field key={name} name={name as keyof typeof labels}>
          {(field) => (
            <div className="form-field">
              <label htmlFor={`connection-${name}`}>
                {labels[name as keyof typeof labels]}
              </label>
              <Input
                id={`connection-${name}`}
                aria-invalid={invalid.includes(name)}
                aria-describedby="connection-result"
                name={name}
                type={
                  name === 'token' || name === 'challengeCode'
                    ? 'password'
                    : 'text'
                }
                autoComplete="off"
                required
                maxLength={
                  name === 'label' ? 120 : name === 'challengeCode' ? 30 : 4096
                }
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                disabled={pending}
                spellCheck={false}
              />
            </div>
          )}
        </form.Field>
      ))}
      {!connection ? (
        <>
          <p className="field-help">
            Requests read access to orders, products, inventory and fulfillment.
            Provider validation determines whether access can be enabled.
          </p>
          {provider !== 'shopify' ? (
            <form.Field name="write">
              {(field) => (
                <label className="connection-checkbox">
                  <input
                    type="checkbox"
                    checked={field.state.value}
                    onChange={(e) => field.handleChange(e.target.checked)}
                    disabled={pending}
                  />
                  Permit shipping-method corrections (requires salesorders.read,
                  salesorders.write and provider idempotency support)
                </label>
              )}
            </form.Field>
          ) : null}
        </>
      ) : null}
      <p id="connection-result" role="alert" ref={result} tabIndex={-1}>
        {message}
      </p>
      {uncertain ? (
        <p>Close this form and refresh the list before submitting again.</p>
      ) : null}
      <Button type="submit" disabled={pending || uncertain}>
        {pending
          ? 'Saving…'
          : connection
            ? 'Confirm replacement'
            : 'Save connection'}
      </Button>
    </form>
  );
}
