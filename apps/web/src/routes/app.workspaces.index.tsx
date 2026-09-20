import { createFileRoute } from '@tanstack/react-router';

import { WorkspaceList } from '../features/identity/workspaces';

export const Route = createFileRoute('/app/workspaces/')({
  component: WorkspaceList,
});
