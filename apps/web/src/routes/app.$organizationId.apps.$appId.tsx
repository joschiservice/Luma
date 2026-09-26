import { createFileRoute } from '@tanstack/react-router';

import { AppExtension } from '../features/apps/extension';

export const Route = createFileRoute('/app/$organizationId/apps/$appId')({
  component: AppPage,
});

/** Hosts a page contributed by an installed workspace app. */
function AppPage() {
  const { organizationId, appId } = Route.useParams();

  return (
    <AppExtension
      key={`${organizationId}/${appId}`}
      appId={appId}
      organizationId={organizationId}
      slot="page"
      done={() => Promise.resolve()}
    />
  );
}
