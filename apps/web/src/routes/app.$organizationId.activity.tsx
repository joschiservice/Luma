import { activityCatalog } from '@luma/api-contract';
import { createFileRoute, redirect } from '@tanstack/react-router';

import {
  activitySearch,
  hasLegacyActivityFilters,
  namesActivityState,
  withoutLegacyActivityFilters,
} from '../features/activity/data';
import { ActivityPage } from '../features/activity/page';
import { rememberedSearch } from '../kit/collections/restore';

export const Route = createFileRoute('/app/$organizationId/activity')({
  validateSearch: activitySearch,
  staticData: { help: 'activity' },
  beforeLoad: async ({ context, params, search }) => {
    // Links from before views, such as `?type=procurement`, become the same conditions.
    if (hasLegacyActivityFilters(search))
      throw redirect({
        to: '/app/$organizationId/activity',
        params,
        search: withoutLegacyActivityFilters(search),
        replace: true,
      });
    // Opened without a view, search, page or open event, Activity returns to the last view.
    if (namesActivityState(search)) return;
    const remembered = await rememberedSearch({
      queryClient: context.queryClient,
      organizationId: params.organizationId,
      catalog: activityCatalog,
      search,
    });
    if (remembered)
      throw redirect({
        to: '/app/$organizationId/activity',
        params,
        search: remembered,
        replace: true,
      });
  },
  component: ActivityPage,
});
