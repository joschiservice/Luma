import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/app/$organizationId/settings/')({
  component: SettingsRedirect,
});

function SettingsRedirect() {
  const { organizationId } = Route.useParams();

  return (
    <Navigate
      to="/app/$organizationId/settings/$section"
      params={{ organizationId, section: 'workspace' }}
      replace
    />
  );
}
