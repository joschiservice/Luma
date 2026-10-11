import { m } from '@luma/i18n/messages';
import { LumaLockup, LumaMark } from '@luma/ui/components/primitives/brand';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { LanguageSelect } from '@luma/ui/components/workspace/language-select';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';

import {
  clearPrivate,
  IdentityError,
  returnPath,
  supportViewJustEnded,
} from './data';
import { retainInvitationToken } from './invitation-return';

/** Renders the Luma lockup linked to the public home page. */
export function Brand() {
  return (
    <a
      className="entry-brand"
      href="/"
      aria-label={m.identity_brand_home_label()}
    >
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
        <p>{m.identity_entry_footer()}</p>
        <LanguageSelect className="entry-language" />
      </footer>
    </main>
  );
}

/** Announces that the workspace session or identity data is loading. */
export function Pending() {
  return (
    <div className="status-page status-pending" role="status">
      <LumaMark className="status-mark" />
      <span>{m.identity_pending_workspace()}</span>
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
      // A support view that just ended explains itself instead of asking staff to sign in.
      supportViewJustEnded()
        ? navigate({ to: '/support-view', replace: true })
        : navigate({
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
  const suspended =
    error instanceof IdentityError && error.code === 'ACCESS_SUSPENDED';
  if (status === 401) return <SignInRedirect />;

  return (
    <EntryFrame>
      <section className="status-panel">
        <h1>
          {suspended
            ? m.identity_failure_suspended_title()
            : status === 404
              ? m.identity_failure_not_found_title()
              : status === 403
                ? m.identity_failure_forbidden_title()
                : m.identity_failure_unavailable_title()}
        </h1>
        <p>
          {suspended
            ? m.identity_failure_suspended_body()
            : status === 404
              ? m.identity_failure_not_found_body()
              : status === 403
                ? m.identity_failure_forbidden_body()
                : m.identity_failure_unavailable_body()}
        </p>
        <div className="status-actions">
          {status !== 403 && status !== 404 ? (
            <Button onClick={retry}>{m.common_try_again()}</Button>
          ) : null}
          <Link
            to="/app/workspaces"
            className={buttonVariants({
              variant: status !== 403 && status !== 404 ? 'outline' : 'default',
            })}
          >
            {m.identity_failure_choose_workspace()}
          </Link>
        </div>
      </section>
    </EntryFrame>
  );
}
