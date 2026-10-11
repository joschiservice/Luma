import { createFileRoute } from '@tanstack/react-router';

import { homeSearch } from '../kit/home/preferences';
import { HomePage } from '../shell/home/page';

export const Route = createFileRoute('/app/$organizationId/home')({
  staticData: { help: 'home' },
  validateSearch: homeSearch,
  component: HomePage,
});
