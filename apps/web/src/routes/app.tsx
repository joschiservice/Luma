import { createFileRoute } from '@tanstack/react-router';

import { Protected } from '../features/identity/protected';

export const Route = createFileRoute('/app')({
  ssr: false,
  component: Protected,
});
