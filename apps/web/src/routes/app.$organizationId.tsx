import { createFileRoute } from '@tanstack/react-router';

import { WorkspaceShell } from '../shell/shell';

export const Route = createFileRoute('/app/$organizationId')({
  ssr: false,
  component: WorkspaceShell,
});
