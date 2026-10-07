import '../apps/apps.css';

import { Alert } from '@luma/ui/components/primitives/alert';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { useEffect } from 'react';

import { AppStore } from '../apps/store';
import { usePermissions } from '../identity/permissions';
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
  const client = useQueryClient();
  const { can } = usePermissions(organizationId);
  const canManage = can('apps.manage');

  return (
    <div className="connections-page apps-page">
      <PageTitle title="Apps" />
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
