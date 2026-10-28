import { createFileRoute } from '@tanstack/react-router';

import { SignOut } from '../features/account/sign-out';

export const Route = createFileRoute('/sign-out')({
  component: SignOut,
});
