import { Button, buttonVariants } from '@luma/ui/button';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';

import { clearPrivate, IdentityError, returnPath } from './data';

/** Renders the shared Luma wordmark linked to the public home page. */
export function Brand() {
  return (
    <a className="wordmark" href="/" aria-label="Luma home">
      Luma<span aria-hidden="true">.</span>
    </a>
  );
}

/** Announces that the workspace session or identity data is loading. */
export function Pending() {
  return (
    <div className="status-page" role="status">
      Opening your workspace…
    </div>
  );
}

/** Redirects to sign-in with the current application location as the return path. */
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

/**
 * Renders status-specific identity errors; authentication redirects to sign-in and
 * inaccessible workspaces offer navigation instead of retry.
 */
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
      <Link to="/app/workspaces" className={buttonVariants()}>
        Choose a workspace
      </Link>
    </main>
  );
}

/** Shows the signed-in user's name and sign-out action. */
export function AccountMenu({ name }: { name: string }) {
  return (
    <details className="account-menu">
      <summary>{name}</summary>
      <a href="/sign-out">Sign out</a>
    </details>
  );
}
