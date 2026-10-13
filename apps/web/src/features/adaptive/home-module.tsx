import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { usePermissions } from '../../kit/identity/permissions';
import { adaptiveAvailabilityOptions, viewsOptions } from './data';

/** Exposes the reader's accessible saved workspaces as a personal Home module. */
export function SavedViewsModule({
  organizationId,
}: {
  organizationId: string;
}) {
  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const { ready } = usePermissions(organizationId);
  const enabled = !!availability.data?.views && ready;
  const views = useQuery({ ...viewsOptions(organizationId), enabled });
  if (availability.isPending)
    return <p role="status">{m.adaptive_loading()}</p>;
  if (!enabled) return <p>{m.adaptive_unavailable()}</p>;
  if (views.isError)
    return (
      <Alert tone="warning">
        {m.adaptive_load_failed()}
        <Button variant="outline" onClick={() => void views.refetch()}>
          {m.adaptive_retry()}
        </Button>
      </Alert>
    );
  if (views.isPending) return <p role="status">{m.adaptive_loading()}</p>;
  const items = views.data.items.filter((view) => !view.archived).slice(0, 8);

  return (
    <div className="adaptive-view-copy">
      {items.length ? (
        items.map((view) => (
          <div className="adaptive-view-heading" key={view.id}>
            <Link
              to="/app/$organizationId/views/$viewId"
              params={{ organizationId, viewId: view.id }}
              search={{}}
            >
              {view.name}
            </Link>
            <Badge>
              {view.sharing.scope === 'private'
                ? m.adaptive_private()
                : m.adaptive_workspace()}
            </Badge>
          </div>
        ))
      ) : (
        <p>{m.adaptive_empty_body()}</p>
      )}
      <Link
        to="/app/$organizationId/views"
        params={{ organizationId }}
        search={{}}
      >
        {m.adaptive_all()}
      </Link>
    </div>
  );
}
