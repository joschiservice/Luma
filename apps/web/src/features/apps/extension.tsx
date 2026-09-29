import type { InstalledConnection } from '@luma/api-contract';
import type { AppUiProps } from '@luma/app-host/web';
import { useQuery } from '@tanstack/react-query';
import {
  Component,
  type ComponentType,
  createElement,
  lazy,
  type ReactNode,
  Suspense,
} from 'react';

import {
  changeConnection,
  connectionError,
  installConnection,
} from '../connections/data';
import { IdentityError } from '../identity/data';
import { appsOptions } from './data';

const modules = import.meta.glob<{ default: ComponentType<AppUiProps> }>(
  '../../../../../packages/apps/*/src/web/index.tsx',
);
const components = new Map(
  Object.entries(modules).map(([path, load]) => [
    path.split('/apps/')[1]!.split('/')[0]!,
    lazy(load),
  ]),
);

class ExtensionBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p role="alert">This app could not load. Refresh to try again.</p>
    ) : (
      this.props.children
    );
  }
}

/** Mounts app UI only after current workspace installation and slot availability are confirmed. */
export function AppExtension({
  appId,
  organizationId,
  slot,
  connection,
  record,
  done,
}: {
  appId: string;
  organizationId: string;
  slot: AppUiProps['slot'];
  connection?: InstalledConnection;
  record?: AppUiProps['record'];
  done: () => Promise<void>;
}) {
  const state = useQuery(appsOptions(organizationId));
  if (state.isPending) return <p role="status">Loading app…</p>;
  if (state.error) return <p role="alert">{connectionError(state.error)}</p>;
  const manifest = state.data.catalog.find((app) => app.id === appId);
  const installed = state.data.installations.some(
    (app) => app.appId === appId && app.status === 'installed',
  );
  const Extension = components.get(appId);
  if (!installed || !manifest || !manifest.ui.includes(slot) || !Extension)
    return <p>This app is unavailable in this workspace.</p>;
  const services: AppUiProps['services'] = {
    install: (input) => installConnection(organizationId, input),
    rotate: (current, credentials) =>
      changeConnection(organizationId, current, 'rotate', credentials),
    error: connectionError,
    uncertain: (error) =>
      !(error instanceof IdentityError) ||
      error.status >= 500 ||
      error.status === 409,
    async request(path, body) {
      if (!/^[a-z0-9-]+$/.test(path)) throw new Error('Invalid app operation');
      const response = await fetch(
        `/api/v1/organizations/${encodeURIComponent(organizationId)}/apps/${encodeURIComponent(appId)}/${path}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw new IdentityError(response.status);

      return response.json();
    },
  };

  return (
    <ExtensionBoundary
      key={`${organizationId}/${appId}/${slot}/${record?.connectionId ?? ''}/${record?.externalId ?? ''}`}
    >
      <Suspense fallback={<p role="status">Loading app…</p>}>
        {createElement(Extension, {
          organizationId,
          slot,
          connection,
          record,
          done,
          services,
        })}
      </Suspense>
    </ExtensionBoundary>
  );
}
