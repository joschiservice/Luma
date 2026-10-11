import { createFileRoute } from '@tanstack/react-router';

import { SupportViewEntry } from '../features/account/support-view';

export const Route = createFileRoute('/support-view')({
  ssr: false,
  component: SupportViewEntry,
});
