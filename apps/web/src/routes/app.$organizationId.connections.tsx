import { createFileRoute } from '@tanstack/react-router';
import { Unavailable } from '../features/identity/shell';
export const Route = createFileRoute('/app/$organizationId/connections')({
  component: () => <Unavailable feature="Connections" />,
});
