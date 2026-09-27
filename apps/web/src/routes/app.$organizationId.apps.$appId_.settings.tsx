import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { AppSettings } from '../features/apps/settings';

export const Route = createFileRoute(
  '/app/$organizationId/apps/$appId_/settings',
)({
  validateSearch: z.object({
    appResult: z
      .enum(['connected', 'denied', 'permissions', 'failed'])
      .optional()
      .catch(undefined),
  }),
  component: AppSettingsPage,
});

/** Hosts workspace app management separately from app-contributed pages. */
function AppSettingsPage() {
  const { organizationId, appId } = Route.useParams();
  const { appResult } = Route.useSearch();

  return (
    <AppSettings
      key={`${organizationId}/${appId}`}
      organizationId={organizationId}
      appId={appId}
      appResult={appResult}
    />
  );
}
