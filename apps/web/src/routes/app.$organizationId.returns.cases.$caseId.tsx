import { createFileRoute } from '@tanstack/react-router';

import { ReturnCasePage } from '../features/returns/case';

export const Route = createFileRoute(
  '/app/$organizationId/returns/cases/$caseId',
)({
  staticData: { help: 'returns' },
  component: ReturnCasePage,
});
