import { inboxCatalog } from '@luma/api-contract';
import { createFileRoute, redirect } from '@tanstack/react-router';

import {
  hasLegacyFilters,
  inboxSearch,
  namesListState,
  withoutLegacyFilters,
} from '../features/inbox/data';
import { InboxPage } from '../features/inbox/page';
import { rememberedSearch } from '../kit/collections/restore';

export const Route = createFileRoute('/app/$organizationId/inbox/')({
  validateSearch: inboxSearch,
  staticData: { help: 'inbox' },
  beforeLoad: async ({ context, params, search }) => {
    // Links from before views name a mailbox; it becomes the same condition.
    if (hasLegacyFilters(search))
      throw redirect({
        to: '/app/$organizationId/inbox',
        params,
        search: withoutLegacyFilters(search),
        replace: true,
      });
    // Opened without a view, search or thread, the inbox returns to the member's last view.
    if (namesListState(search)) return;
    const remembered = await rememberedSearch({
      queryClient: context.queryClient,
      organizationId: params.organizationId,
      catalog: inboxCatalog,
      search,
    });
    if (remembered)
      throw redirect({
        to: '/app/$organizationId/inbox',
        params,
        search: remembered,
        replace: true,
      });
  },
  component: InboxPage,
});
