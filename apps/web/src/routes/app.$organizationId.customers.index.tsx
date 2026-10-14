import { customersCatalog } from '@luma/api-contract';
import { createFileRoute, redirect } from '@tanstack/react-router';

import {
  customersSearch,
  hasLegacyFilters,
  namesListState,
  withoutLegacyFilters,
} from '../features/customers/data';
import { CustomersPage } from '../features/customers/page';
import { rememberedSearch } from '../kit/collections/restore';

export const Route = createFileRoute('/app/$organizationId/customers/')({
  validateSearch: customersSearch,
  staticData: { help: 'customers' },
  beforeLoad: async ({ context, params, search }) => {
    // Links from before views keep working: their filters become the same conditions.
    if (hasLegacyFilters(search))
      throw redirect({
        to: '/app/$organizationId/customers',
        params,
        search: withoutLegacyFilters(search),
        replace: true,
      });
    // Opened without a view, search, page or customer link, Customers returns to the last view.
    if (namesListState(search)) return;
    const remembered = await rememberedSearch({
      queryClient: context.queryClient,
      organizationId: params.organizationId,
      catalog: customersCatalog,
      search,
    });
    if (remembered)
      throw redirect({
        to: '/app/$organizationId/customers',
        params,
        search: remembered,
        replace: true,
      });
  },
  component: CustomersPage,
});
