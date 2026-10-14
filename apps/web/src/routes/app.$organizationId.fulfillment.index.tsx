import { fulfillmentCatalog } from '@luma/api-contract';
import { createFileRoute, redirect } from '@tanstack/react-router';

import {
  fulfillmentSearch,
  hasLegacyFilters,
  namesListState,
  withoutLegacyFilters,
} from '../features/fulfillment/data';
import { FulfillmentPage } from '../features/fulfillment/page';
import { rememberedSearch } from '../kit/collections/restore';

export const Route = createFileRoute('/app/$organizationId/fulfillment/')({
  validateSearch: fulfillmentSearch,
  staticData: { help: 'fulfillment' },
  beforeLoad: async ({ context, params, search }) => {
    // Links from before views, such as Insights drill-downs, become the same conditions.
    if (hasLegacyFilters(search))
      throw redirect({
        to: '/app/$organizationId/fulfillment',
        params,
        search: withoutLegacyFilters(search),
        replace: true,
      });
    // Opened without a view, search, page or context, Fulfillment returns to the member's last view.
    if (namesListState(search)) return;
    const remembered = await rememberedSearch({
      queryClient: context.queryClient,
      organizationId: params.organizationId,
      catalog: fulfillmentCatalog,
      search,
    });
    if (remembered)
      throw redirect({
        to: '/app/$organizationId/fulfillment',
        params,
        search: remembered,
        replace: true,
      });
  },
  component: FulfillmentPage,
});
