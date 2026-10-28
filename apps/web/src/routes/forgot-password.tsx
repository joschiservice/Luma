import { createFileRoute } from '@tanstack/react-router';

import { PasswordRecovery } from '../features/account/password-recovery';

export const Route = createFileRoute('/forgot-password')({
  component: PasswordRecovery,
});
