import { createFileRoute } from '@tanstack/react-router';

import { viewsSearch } from '../features/adaptive/data';
import { SavedViewPage } from '../features/adaptive/page';

export const Route = createFileRoute('/app/$organizationId/views/$viewId')({
  validateSearch: viewsSearch,
  staticData: { help: 'saved-views' },
  component: SavedViewPage,
});
