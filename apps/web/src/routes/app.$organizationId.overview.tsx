import { createFileRoute } from '@tanstack/react-router';
import { Welcome } from '../features/identity/shell';
export const Route = createFileRoute('/app/$organizationId/overview')({
  component: Welcome,
});
