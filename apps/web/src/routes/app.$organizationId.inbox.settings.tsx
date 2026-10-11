import { createFileRoute } from '@tanstack/react-router';

import { InboxSettingsPage } from '../features/inbox/settings';

export const Route = createFileRoute('/app/$organizationId/inbox/settings')({
  staticData: { help: 'inbox' },
  component: InboxSettingsPage,
});
