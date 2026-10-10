import { Badge } from '@luma/ui/components/primitives/badge';
import { LumaLockup } from '@luma/ui/components/primitives/brand';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { useEffect } from 'react';
import { z } from 'zod';

import { staffApi } from './api';
import { Failure, Loading } from './feedback';
import { clearPrivate, isAccessLoss, sessionOptions } from './queries';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: 5 * 60_000 },
    mutations: { retry: false },
  },
});

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => (
    <main className="staff-content">
      <h1>Page not found</h1>
      <Link to="/" className={buttonVariants({ variant: 'outline' })}>
        Return to directory
      </Link>
    </main>
  ),
});

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: z.object({
    denied: z.boolean().optional().catch(false),
    signInFailed: z.boolean().optional().catch(false),
  }),
  component: lazyRouteComponent(() => import('./login'), 'LoginPage'),
});

const protectedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'staff',
  beforeLoad: async () => {
    try {
      await queryClient.fetchQuery(sessionOptions());
    } catch (error) {
      if (isAccessLoss(error)) {
        await clearPrivate(queryClient);
        throw redirect({ to: '/login', search: { denied: true } });
      }
      throw error;
    }
  },
  pendingComponent: () => (
    <main className="staff-content">
      <Loading>Checking staff access…</Loading>
    </main>
  ),
  errorComponent: ({ error, reset }) => (
    <main className="staff-content">
      <Failure error={error} retry={reset} />
    </main>
  ),
  component: StaffShell,
});

export const directoryRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/',
  validateSearch: z.object({ query: z.string().max(100).optional().catch('') }),
  component: lazyRouteComponent(() => import('./directory'), 'DirectoryPage'),
});

export const workspaceRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/workspaces/$workspaceId',
  validateSearch: z.object({ grantId: z.uuid().optional().catch(undefined) }),
  component: lazyRouteComponent(() => import('./workspace'), 'WorkspacePage'),
});

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);
const filter = z.string().trim().max(320).optional().catch(undefined);

export const auditRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: '/audit',
  validateSearch: z.object({
    staff: filter,
    workspace: z.uuid().optional().catch(undefined),
    account: filter,
    event: z
      .string()
      .regex(/^[a-z][a-z0-9.-]{0,99}$/)
      .optional()
      .catch(undefined),
    from: day,
    to: day,
  }),
  component: lazyRouteComponent(() => import('./audit'), 'AuditPage'),
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    protectedRoute.addChildren([directoryRoute, workspaceRoute, auditRoute]),
  ]),
  defaultPreload: false,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

function StaffShell() {
  const client = useQueryClient();
  const session = useQuery(sessionOptions());
  const logout = useMutation({
    mutationFn: async () => {
      await staffApi.signOut();
      await clearPrivate(client);
      window.location.replace('/login');
    },
  });
  useEffect(() => {
    // Query's visibility listener covers tab changes; window focus also rechecks offboarding.
    const recheckAccess = () => {
      void client.invalidateQueries({ queryKey: ['staff', 'session'] });
    };
    window.addEventListener('focus', recheckAccess);

    return () => window.removeEventListener('focus', recheckAccess);
  }, [client]);
  useEffect(() => {
    if (session.isError && isAccessLoss(session.error)) {
      void clearPrivate(client).then(() =>
        window.location.replace('/login?denied=true'),
      );
    }
  }, [client, session.error, session.isError]);
  if (session.isError)
    return (
      <main className="staff-content">
        <Failure error={session.error} retry={() => void session.refetch()} />
      </main>
    );
  if (!session.data)
    return (
      <main className="staff-content">
        <Loading>Checking staff access…</Loading>
      </main>
    );

  return (
    <div className="staff-shell">
      <a href="#staff-content" className={`staff-skip ${buttonVariants()}`}>
        Skip to content
      </a>
      <header className="staff-bar">
        <div className="staff-brand">
          <Link to="/" aria-label="Luma staff directory">
            <LumaLockup />
          </Link>
          <Badge>Staff</Badge>
          <Link
            to="/"
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            Directory
          </Link>
          {session.data.permissions.includes('staff.audit.read') ? (
            <Link
              to="/audit"
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              Audit log
            </Link>
          ) : null}
        </div>
        <div className="staff-actions">
          <span className="staff-muted">{session.data.user.email}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            {logout.isPending ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      </header>
      <main id="staff-content" className="staff-content" tabIndex={-1}>
        {logout.isError ? <Failure error={logout.error} /> : null}
        <Outlet />
      </main>
    </div>
  );
}
