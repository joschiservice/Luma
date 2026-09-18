import { useEffect } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@luma/ui/button';
import { clearPrivate, IdentityError, returnPath } from './data';

export function Brand() {
  return (
    <a className="wordmark" href="/" aria-label="Luma home">
      Luma<span aria-hidden="true">.</span>
    </a>
  );
}
export function Pending() {
  return (
    <div className="status-page" role="status">
      Opening your workspace…
    </div>
  );
}
export function SignInRedirect() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const href = useLocation({ select: (location) => location.href });
  useEffect(() => {
    void clearPrivate(client).then(() =>
      navigate({
        to: '/sign-in',
        search: { returnTo: returnPath(href) },
        replace: true,
      }),
    );
  }, [client, href, navigate]);
  return <Pending />;
}
export function Failure({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  const status = error instanceof IdentityError ? error.status : 503;
  if (status === 401) return <SignInRedirect />;
  return (
    <main className="status-page">
      <Brand />
      <h1>
        {status === 404
          ? 'Workspace unavailable'
          : status === 403
            ? 'Permission denied'
            : 'We couldn’t connect'}
      </h1>
      <p>
        {status === 404
          ? 'This workspace is unavailable or you no longer have access.'
          : status === 403
            ? 'You do not have permission to open this page.'
            : 'Your session may still be active. Check your connection and try again.'}
      </p>
      {status !== 403 && status !== 404 ? (
        <Button onClick={retry}>Try again</Button>
      ) : null}
      <Link to="/app/workspaces">Choose a workspace</Link>
    </main>
  );
}
export function AccountMenu({ name }: { name: string }) {
  return (
    <details className="account-menu">
      <summary>{name}</summary>
      <a href="/sign-out">Sign out</a>
    </details>
  );
}
