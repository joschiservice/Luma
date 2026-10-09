import type { InstalledConnection } from '@luma/api-contract';
import type { AppUiProps } from '@luma/app-host/web';
import { m } from '@luma/i18n/messages';
import { useQuery } from '@tanstack/react-query';
import {
  Component,
  type ComponentType,
  createElement,
  lazy,
  type ReactNode,
  Suspense,
  useMemo,
} from 'react';

import {
  changeConnection,
  connectionError,
  installConnection,
} from '../connections/data';
import { IdentityError, sessionOptions } from '../identity/data';
import { NoAccess, usePermissions } from '../identity/permissions';
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
      <p role="alert">{m.apps_extension_failed()}</p>
    ) : (
      this.props.children
    );
  }
}

/**
 * Mounts app UI only after current workspace installation, slot availability and the slot's
 * declared permission are confirmed. Slots the person can't use are not mounted.
 */
export function AppExtension({
  appId,
  organizationId,
  slot,
  connection,
  record,
  inventory,
  fulfillment,
  done,
}: {
  appId: string;
  organizationId: string;
  slot: AppUiProps['slot'];
  connection?: InstalledConnection;
  record?: AppUiProps['record'];
  inventory?: AppUiProps['inventory'];
  fulfillment?: AppUiProps['fulfillment'];
  done: () => Promise<void>;
}) {
  const state = useQuery(appsOptions(organizationId));
  const session = useQuery(sessionOptions());
  const { can } = usePermissions(organizationId);
  const services = useMemo<AppUiProps['services']>(
    () => ({
      install: (input) => installConnection(organizationId, input),
      rotate: (current, credentials) =>
        changeConnection(organizationId, current, 'rotate', credentials),
      error: (error) =>
        slot === 'inventory' && error instanceof IdentityError && error.code
          ? error.message
          : connectionError(error),
      uncertain: (error) =>
        !(error instanceof IdentityError) ||
        error.status >= 500 ||
        (slot !== 'inventory' && error.status === 409),
      async request(path, body) {
        if (!/^[a-z0-9-]+$/.test(path))
          throw new Error('Invalid app operation');
        const response = await fetch(
          `/api/v1/organizations/${encodeURIComponent(organizationId)}/apps/${encodeURIComponent(appId)}/${path}`,
          {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (!response.ok)
          throw new IdentityError(
            response.status,
            await response.json().catch(() => undefined),
          );

        return response.json();
      },
    }),
    [organizationId, appId, slot],
  );
  if (state.isPending) return <p role="status">{m.apps_loading_app()}</p>;
  if (state.error) return <p role="alert">{connectionError(state.error)}</p>;
  const manifest = state.data.catalog.find((app) => app.id === appId);
  const installed = state.data.installations.some(
    (app) => app.appId === appId && app.status === 'installed',
  );
  const Extension = components.get(appId);
  if (!installed || !manifest || !manifest.ui.includes(slot) || !Extension)
    return <p>{m.apps_extension_unavailable()}</p>;
  const permission = manifest.slotAccess[slot];
  if (!permission || !can(permission))
    return slot === 'page' && permission ? (
      <NoAccess
        organizationId={organizationId}
        area={manifest.name}
        permission={permission}
      />
    ) : null;

  return (
    <ExtensionBoundary
      key={`${session.data?.sessionId ?? ''}/${organizationId}/${appId}/${slot}/${record?.connectionId ?? ''}/${record?.externalId ?? ''}/${inventory?.positionId ?? ''}/${fulfillment?.fulfillmentId ?? ''}`}
    >
      <Suspense fallback={<p role="status">{m.apps_loading_app()}</p>}>
        {createElement(Extension, {
          organizationId,
          slot,
          connection,
          record,
          inventory,
          fulfillment,
          done,
          services,
          can,
        })}
      </Suspense>
    </ExtensionBoundary>
  );
}
