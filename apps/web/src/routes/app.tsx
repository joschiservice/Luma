import { ClientOnly, createFileRoute } from '@tanstack/react-router';

import { Pending } from '../kit/identity/common';
import { Protected } from '../kit/identity/protected';

// The session and everything below it are read in the browser, so the server renders only the
// public pending page that `Protected` shows until the session arrives. Child routes are
// `ssr: false` so their loaders never run on the server.
export const Route = createFileRoute('/app')({
  component: () => (
    <ClientOnly fallback={<Pending />}>
      <Protected />
    </ClientOnly>
  ),
});
