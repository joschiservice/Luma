import { LumaLockup, LumaMark } from '@luma/ui/components/primitives/brand';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';

import { clearPrivate, IdentityError, returnPath } from './data';
import { retainInvitationToken } from './invitation-return';

/** Renders the Luma lockup linked to the public home page. */
export function Brand() {
  return (
    <a className="entry-brand" href="/" aria-label="Luma home">
      <LumaLockup />
    </a>
  );
}

/**
 * Frames pages outside a workspace, such as workspace selection and status pages,
 * with the Luma lockup, optional header actions and a centered body.
 */
export function EntryFrame({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <main className="entry">
      <header className="entry-bar">
        <Brand />
        {actions ? <div className="entry-bar-actions">{actions}</div> : null}
      </header>
      <div className="entry-body">{children}</div>
      <footer className="entry-footer">
        Luma is built by Auren Labs with a small group of design partners.
      </footer>
    </main>
  );
}

/** Announces that the workspace session or identity data is loading. */
export function Pending() {
  return (
    <div className="status-page status-pending" role="status">
      <LumaMark className="status-mark" />
      <span>Opening your workspace…</span>
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
        search: { returnTo: returnPath(retainInvitationToken(href)) },
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
    <EntryFrame>
      <section className="status-panel">
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
        <div className="status-actions">
          {status !== 403 && status !== 404 ? (
            <Button onClick={retry}>Try again</Button>
          ) : null}
          <Link
            to="/app/workspaces"
            className={buttonVariants({
              variant: status !== 403 && status !== 404 ? 'outline' : 'default',
            })}
          >
            Choose a workspace
          </Link>
        </div>
      </section>
    </EntryFrame>
  );
}
