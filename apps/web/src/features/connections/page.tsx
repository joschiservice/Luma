import '../apps/apps.css';

import { Alert } from '@luma/ui/components/primitives/alert';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { useEffect } from 'react';

import { AppStore } from '../apps/store';
import { contextOptions } from '../identity/data';
import { connectionsOptions } from './data';

/** Lists apps and forwards existing connection links to their app management page. */
export function ConnectionsPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const { appResult } = useSearch({ from: '/app/$organizationId/apps/' });
  const connections = useQuery(connectionsOptions(organizationId));
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  useEffect(() => {
    const connection = connections.data?.find(
      (item) => hash === `connection-${item.id}`,
    );
    const appId = connection?.appId;
    if (appId)
      void navigate({
        to: '/app/$organizationId/apps/$appId/settings',
        params: { organizationId, appId },

        hash: connection ? `connection-${connection.id}` : '',
        replace: true,
      });
  }, [connections.data, organizationId, navigate, hash]);

  return (
    <Connections
      key={organizationId}
      organizationId={organizationId}
      appResult={appResult}
    />
  );
}

/** Shows installed app status and available workspace apps. */
export function Connections({
  organizationId,
  appResult,
}: {
  organizationId: string;
  appResult?: string | undefined;
}) {
  const access = useQuery(contextOptions(organizationId));
  const client = useQueryClient();
  const canManage =
    access.data?.actor.role === 'owner' || access.data?.actor.role === 'admin';

  return (
    <div className="connections-page apps-page">
      <PageHeader
        title="Apps"
        description="Connect the systems Luma works across. Install an app, then connect accounts and choose what Luma may read and change."
      />
      {appResult ? (
        <Alert
          role="status"
          tone={appResult === 'connected' ? 'success' : 'warning'}
        >
          {appResult === 'connected'
            ? 'Connection ready.'
            : 'Authorization needs attention. Open the app to try again.'}
        </Alert>
      ) : null}
      <AppStore
        organizationId={organizationId}
        canManage={canManage}
        refresh={async () => {
          await client.invalidateQueries({
            queryKey: connectionsOptions(organizationId).queryKey,
          });
        }}
      />
    </div>
  );
}
