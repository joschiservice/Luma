import { createFileRoute } from '@tanstack/react-router';

import { AppSettings } from '../features/apps/settings';
import { appResultSearch } from '../kit/apps/data';

export const Route = createFileRoute(
  '/app/$organizationId/apps/$appId_/settings',
)({
  validateSearch: appResultSearch,
  staticData: { help: 'apps-and-connections' },
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
