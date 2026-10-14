import { createFileRoute, redirect } from '@tanstack/react-router';

import { viewOptions, viewsSearch } from '../features/adaptive/data';
import { SavedViewPage } from '../features/adaptive/page';
import { savedViewPath } from '../kit/collections/pages';

export const Route = createFileRoute('/app/$organizationId/views/$viewId')({
  validateSearch: viewsSearch,
  staticData: { help: 'saved-views' },
  // Views live on their list page; `manage` opens their settings, history and actions here.
  beforeLoad: async ({ context, params, search }) => {
    if (search.manage) return;
    const view = await context.queryClient
      .ensureQueryData(viewOptions(params.organizationId, params.viewId))
      .catch(() => null);
    const path = view
      ? savedViewPath(
          view.query.domain,
          view.id,
          view.query.metrics.length > 0 || view.query.charts.length > 0,
        )
      : null;
    if (path)
      throw redirect({
        href: `/app/${params.organizationId}/${path}`,
        replace: true,
      });
  },
  component: SavedViewPage,
});
