import { createFileRoute } from '@tanstack/react-router';

import { returnsSearch } from '../features/returns/data';
import { ReturnPage } from '../features/returns/detail';

export const Route = createFileRoute('/app/$organizationId/returns/$returnId')({
  validateSearch: returnsSearch,
  staticData: { help: 'returns' },
  component: ReturnPage,
});
