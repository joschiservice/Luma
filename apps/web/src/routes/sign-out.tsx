import { createFileRoute } from '@tanstack/react-router';
import { SignOut } from '../features/identity/sign-out';
export const Route = createFileRoute('/sign-out')({
  ssr: false,
  component: SignOut,
});
