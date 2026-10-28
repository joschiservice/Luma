import { createFileRoute } from '@tanstack/react-router';

import { WorkspaceList } from '../features/account/workspaces';

export const Route = createFileRoute('/app/workspaces/')({
  ssr: false,
  component: WorkspaceList,
});
