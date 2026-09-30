import { createFileRoute } from '@tanstack/react-router';

import { needsYouSearch } from '../features/decisions/data';
import { NeedsYouPage } from '../features/decisions/page';

export const Route = createFileRoute('/app/$organizationId/needs-you')({
  validateSearch: needsYouSearch,
  staticData: { help: 'needs-you' },
  component: NeedsYouPage,
});
