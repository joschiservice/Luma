import { createFileRoute } from '@tanstack/react-router';

import { recordsSearch } from '../features/records/data';
import { RecordsPage } from '../features/records/page';

export const Route = createFileRoute('/app/$organizationId/records/')({
  validateSearch: recordsSearch,
  component: RecordsPage,
});
