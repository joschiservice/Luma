import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute(
  '/app/$organizationId/exceptions/$exceptionId',
)({ component: () => null });
