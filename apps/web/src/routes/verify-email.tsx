import { createFileRoute } from '@tanstack/react-router';

import { EmailVerification } from '../features/account/email-verification';

export const Route = createFileRoute('/verify-email')({
  ssr: false,
  component: EmailVerification,
});
