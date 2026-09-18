import { createFileRoute } from '@tanstack/react-router';
import { ConnectionsPage } from '../features/connections/page';
export const Route = createFileRoute('/app/$organizationId/connections')({
  component: ConnectionsPage,
});
