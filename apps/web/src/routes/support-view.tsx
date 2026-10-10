import { createFileRoute } from '@tanstack/react-router';

import { SupportViewEntry } from '../features/identity/support-view';

export const Route = createFileRoute('/support-view')({
  ssr: false,
  component: SupportViewEntry,
});
