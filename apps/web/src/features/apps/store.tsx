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
} from '@luma/ui/components/primitives/dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { connectionError } from '../connections/data';
import { appsOptions, changeApp } from './data';
import { AppExtension } from './extension';

/** Shows catalog metadata without importing apps; installation enables their settings UI. */
export function AppStore({
  organizationId,
  canManage,
  refresh,
}: {
  organizationId: string;
  canManage: boolean;
  refresh: () => Promise<void>;
}) {
  const query = useQuery(appsOptions(organizationId));
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  async function change(id: string, action: 'install' | 'uninstall') {
    if (pending) return;
    setPending(true);
    setMessage('');
    try {
      const current = query.data?.installations.find(
        (item) => item.appId === id,
      );
      await changeApp(organizationId, id, action, current?.version ?? null);
      await client.invalidateQueries({
        queryKey: appsOptions(organizationId).queryKey,
      });
      await refresh();
      setRemoving(null);
      const manifest = query.data?.catalog.find((app) => app.id === id);
      setSelected(
        action === 'install' &&
          manifest?.ui.some(
            (slot) => slot === 'connections' || slot === 'settings',
          )
          ? id
          : null,
      );
      setMessage(
        action === 'install'
          ? 'App installed. Configure it to get started.'
          : 'App uninstalled. Connection credentials have been removed.',
      );
    } catch (error) {
      setMessage(connectionError(error));
    } finally {
      setPending(false);
    }
  }

  if (query.isPending) return <p role="status">Loading apps…</p>;
  if (query.error) return <p role="alert">{connectionError(query.error)}</p>;
  const unavailable = query.data.installations.filter(
    (item) =>
      item.status === 'installed' &&
      !query.data.catalog.some((app) => app.id === item.appId),
  );

  return (
    <section className="connections-section">
      <h2>Workspace apps</h2>
      {!canManage ? (
        <p>An owner or admin can install and configure apps.</p>
      ) : null}
      <div className="connection-providers">
        {query.data.catalog.map((app) => {
          const installed = query.data.installations.some(
            (item) => item.appId === app.id && item.status === 'installed',
          );

          return (
            <Card as="article" key={app.id}>
              <CardHeader>
                <CardTitle as="h3">{app.name}</CardTitle>
              </CardHeader>
              <p>{app.description}</p>
              <p>
                {installed ? 'Installed' : 'Available'} · {app.version}
              </p>
              {installed ? (
                <>
                  <Button
                    variant="outline"
                    disabled={
                      !canManage ||
                      pending ||
                      !app.ui.some(
                        (slot) => slot === 'connections' || slot === 'settings',
                      )
                    }
                    onClick={() => setSelected(app.id)}
                  >
                    Configure
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!canManage || pending}
                    onClick={() => setRemoving(app.id)}
                  >
                    Uninstall
                  </Button>
                </>
              ) : (
                <Button
                  disabled={!canManage || pending}
                  onClick={() => void change(app.id, 'install')}
                >
                  Install {app.name}
                </Button>
              )}
            </Card>
          );
        })}
        {unavailable.map((app) => (
          <Card key={app.appId}>
            <CardTitle>{app.appId}</CardTitle>
            <p>App unavailable. Historical records remain accessible.</p>
            <Button
              disabled={!canManage || pending}
              onClick={() => setRemoving(app.appId)}
            >
              Uninstall
            </Button>
          </Card>
        ))}
      </div>
      {!query.data.catalog.length && !unavailable.length ? (
        <p>No apps are available in this deployment.</p>
      ) : null}
      <p role="status">{message}</p>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="connection-dialog">
          <DialogTitle>Configure app</DialogTitle>
          <DialogDescription>
            Connect an account to enable the app’s capabilities.
          </DialogDescription>
          {selected ? (
            <AppExtension
              key={selected}
              appId={selected}
              organizationId={organizationId}
              slot={
                query.data.catalog
                  .find((app) => app.id === selected)
                  ?.ui.includes('connections')
                  ? 'connections'
                  : 'settings'
              }
              done={async () => {
                setSelected(null);
                await refresh();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Uninstall app?</DialogTitle>
          <DialogDescription>
            This stops new app operations and deletes credentials for all its
            connections. Historical records remain. Requests already sent may
            finish.
          </DialogDescription>
          <Button
            disabled={pending}
            onClick={() => {
              if (removing) void change(removing, 'uninstall');
            }}
          >
            {pending ? 'Uninstalling…' : 'Confirm uninstall'}
          </Button>
          <p role="status">{message}</p>
        </DialogContent>
      </Dialog>
    </section>
  );
}
