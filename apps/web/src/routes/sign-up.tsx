import { createFileRoute } from '@tanstack/react-router';

import { AuthForm } from '../features/account/auth-form';
import { authSearch } from '../kit/identity/data';

export const Route = createFileRoute('/sign-up')({
  validateSearch: authSearch,
  component: Page,
});

function Page() {
  const { returnTo } = Route.useSearch();

  return <AuthForm signup={true} returnTo={returnTo} />;
}
