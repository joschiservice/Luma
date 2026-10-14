import { returnsCatalog } from '@luma/api-contract';
import { createFileRoute, redirect } from '@tanstack/react-router';

import {
  hasLegacyFilters,
  namesListState,
  returnsSearch,
  withoutLegacyFilters,
} from '../features/returns/data';
import { ReturnsPage } from '../features/returns/page';
import { rememberedSearch } from '../kit/collections/restore';

export const Route = createFileRoute('/app/$organizationId/returns/')({
  validateSearch: returnsSearch,
  staticData: { help: 'returns' },
  beforeLoad: async ({ context, params, search }) => {
    // Links from before views, such as Home's stage rows, become the same conditions.
    if (hasLegacyFilters(search))
      throw redirect({
        to: '/app/$organizationId/returns',
        params,
        search: withoutLegacyFilters(search),
        replace: true,
      });
    // Opened without a view, search, page or context, Returns returns to the member's last view.
    if (namesListState(search)) return;
    const remembered = await rememberedSearch({
      queryClient: context.queryClient,
      organizationId: params.organizationId,
      catalog: returnsCatalog,
      search,
    });
    if (remembered)
      throw redirect({
        to: '/app/$organizationId/returns',
        params,
        search: remembered,
        replace: true,
      });
  },
  component: ReturnsPage,
});
