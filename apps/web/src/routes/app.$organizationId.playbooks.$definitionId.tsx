import { createFileRoute } from '@tanstack/react-router';

import { PlaybookPage } from '../features/playbooks/detail';
import { parsePlaybookFilters } from '../features/playbooks/library';

export const Route = createFileRoute(
  '/app/$organizationId/playbooks/$definitionId',
)({ validateSearch: parsePlaybookFilters, component: PlaybookPage });
