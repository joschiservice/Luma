import { createFileRoute } from '@tanstack/react-router';

import { returnsSearch } from '../features/returns/data';
import { ReturnsPage } from '../features/returns/page';

export const Route = createFileRoute('/app/$organizationId/returns/')({
  validateSearch: returnsSearch,
  staticData: { help: 'returns' },
  component: ReturnsPage,
});
