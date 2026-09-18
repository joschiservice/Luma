import { createFileRoute } from '@tanstack/react-router';
import { WorkspaceShell } from '../features/identity/shell';
export const Route = createFileRoute('/app/$organizationId')({
  component: WorkspaceShell,
});
