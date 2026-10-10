import { createFileRoute } from '@tanstack/react-router';

import { PasswordRecovery } from '../features/identity/password-recovery';

export const Route = createFileRoute('/forgot-password')({
  ssr: false,
  component: PasswordRecovery,
});
