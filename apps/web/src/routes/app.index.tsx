import { createFileRoute } from '@tanstack/react-router';

import { WorkspaceList } from '../features/account/workspaces';

export const Route = createFileRoute('/app/')({
  ssr: false,
  component: () => <WorkspaceList entry />,
});
