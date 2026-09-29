import { createFileRoute } from '@tanstack/react-router';

import { recordsSearch } from '../features/records/data';
import { RecordDetailPage } from '../features/records/page';

export const Route = createFileRoute(
  '/app/$organizationId/records/$kind/$recordId',
)({
  validateSearch: recordsSearch,
  component: RecordDetailPage,
});
