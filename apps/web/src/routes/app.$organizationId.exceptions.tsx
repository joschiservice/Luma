import { createFileRoute } from '@tanstack/react-router';
import { Unavailable } from '../features/identity/shell';
export const Route = createFileRoute('/app/$organizationId/exceptions')({
  component: () => <Unavailable feature="Exceptions" />,
});
