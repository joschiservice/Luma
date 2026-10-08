import { createFileRoute } from '@tanstack/react-router';

import { HomePage } from '../features/home/page';
import { homeSearch } from '../features/home/preferences';

export const Route = createFileRoute('/app/$organizationId/home')({
  staticData: { help: 'home' },
  validateSearch: homeSearch,
  component: HomePage,
});
