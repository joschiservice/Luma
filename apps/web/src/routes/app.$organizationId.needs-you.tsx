import { decisionsCatalog } from '@luma/api-contract';
import { createFileRoute, redirect } from '@tanstack/react-router';

import {
  hasLegacyFilters,
  namesListState,
  needsYouSearch,
  withoutLegacyFilters,
} from '../features/decisions/data';
import { NeedsYouPage } from '../features/decisions/page';
import { rememberedSearch } from '../kit/collections/restore';

export const Route = createFileRoute('/app/$organizationId/needs-you')({
  validateSearch: needsYouSearch,
  staticData: { help: 'needs-you' },
  beforeLoad: async ({ context, params, search }) => {
    // Links from before views, such as Insights' procurement link, become the same conditions.
    if (hasLegacyFilters(search))
      throw redirect({
        to: '/app/$organizationId/needs-you',
        params,
        search: withoutLegacyFilters(search),
        replace: true,
      });
    // Opened without a view, search, page or decision, the queue returns to the member's last view.
    if (namesListState(search)) return;
    const remembered = await rememberedSearch({
      queryClient: context.queryClient,
      organizationId: params.organizationId,
      catalog: decisionsCatalog,
      search,
    });
    if (remembered)
      throw redirect({
        to: '/app/$organizationId/needs-you',
        params,
        search: remembered,
        replace: true,
      });
  },
  component: NeedsYouPage,
});
