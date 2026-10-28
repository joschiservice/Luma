import { m } from '@luma/i18n/messages';
import { LumaLockup, LumaMark } from '@luma/ui/components/primitives/brand';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { Empty } from '@luma/ui/components/primitives/empty';
import { LanguageSelect } from '@luma/ui/components/workspace/language-select';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ErrorComponentProps,
  Link,
  useLocation,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { MapPinOff, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';

import { useWorkspaceFrame } from '../layout/workspace-frame';
import {
  ApiError,
  clearPrivate,
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
        <div className="entry-bar-actions">
          {actions}
          <LanguageSelect variant="quiet" />
        </div>
      </header>
      <div className="entry-body">{children}</div>
      <footer className="entry-footer">
        <p>{m.identity_entry_footer()}</p>
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
 * Shows a route status inside the workspace frame when one is present, otherwise as a full
 * entry page. The action row always ends with a link to Home.
 */
function RouteStatus({
  title,
  body,
  icon,
  retry,
}: {
  title: string;
  body: string;
  icon: ReactNode;
  retry?: () => void;
}) {
  const organizationId = useWorkspaceFrame();
  const actions = (
    <>
      {retry ? <Button onClick={retry}>{m.common_try_again()}</Button> : null}
      {organizationId ? (
        <Link
          to="/app/$organizationId/home"
          params={{ organizationId }}
          className={buttonVariants({ variant: retry ? 'outline' : 'default' })}
        >
          {m.identity_route_home()}
        </Link>
      ) : (
        <a
          href="/"
          className={buttonVariants({ variant: retry ? 'outline' : 'default' })}
        >
          {m.identity_route_home()}
        </a>
      )}
    </>
  );

  if (organizationId)
    return (
      <Empty className="no-access" aria-labelledby="route-status-title">
        {icon}
        <h2 id="route-status-title">{title}</h2>
        <p>{body}</p>
        <div className="status-actions">{actions}</div>
      </Empty>
    );

  return (
    <EntryFrame>
      <section className="status-panel" aria-labelledby="route-status-title">
        <h1 id="route-status-title">{title}</h1>
        <p>{body}</p>
        <div className="status-actions">{actions}</div>
      </section>
    </EntryFrame>
  );
}

/** Explains an unknown address in the active language and links back to Home. */
export function RouteNotFound() {
  return (
    <RouteStatus
      title={m.identity_route_missing_title()}
      body={m.identity_route_missing_body()}
      icon={<MapPinOff aria-hidden="true" />}
    />
  );
}

/**
 * Replaces a page that failed to load or render. Retry reloads the route, which also resets
 * the error boundary; an ended session redirects to sign-in instead.
 */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  if (error instanceof ApiError && error.status === 401)
    return <SignInRedirect />;

  return (
    <RouteStatus
      title={m.identity_route_error_title()}
      body={m.identity_route_error_body()}
      icon={<TriangleAlert aria-hidden="true" />}
      retry={() => void router.invalidate()}
    />
  );
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
  const status = error instanceof ApiError ? error.status : 503;
  const suspended =
    error instanceof ApiError && error.code === 'ACCESS_SUSPENDED';
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
