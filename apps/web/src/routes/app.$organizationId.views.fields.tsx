import { createFileRoute } from '@tanstack/react-router';

import { FieldsPage } from '../features/adaptive/fields';

export const Route = createFileRoute('/app/$organizationId/views/fields')({
  staticData: { help: 'saved-views' },
  component: FieldsPage,
});
