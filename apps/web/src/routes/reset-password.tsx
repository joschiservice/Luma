import { createFileRoute } from '@tanstack/react-router';

import { PasswordRecovery } from '../features/identity/password-recovery';

export const Route = createFileRoute('/reset-password')({
  ssr: false,
  component: Page,
});

function Page() {
  return <PasswordRecovery reset />;
}
