import { createFileRoute } from '@tanstack/react-router';

import {
  parsePlaybookFilters,
  PlaybooksPage,
} from '../features/playbooks/library';

export const Route = createFileRoute('/app/$organizationId/playbooks/')({
  validateSearch: parsePlaybookFilters,
  component: PlaybooksPage,
});
