import { createFileRoute } from '@tanstack/react-router';

import { NewWorkspace } from '../features/account/workspaces';

export const Route = createFileRoute('/app/workspaces/new')({
  component: NewWorkspace,
});
