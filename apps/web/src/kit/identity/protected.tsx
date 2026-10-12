import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet, useLocation } from '@tanstack/react-router';
import { useEffect } from 'react';

import { useLanguageSync } from '../../lib/language';
import { Failure, Pending, SignInRedirect } from './common';
import { sessionOptions } from './data';

/**
 * Resolves the session before rendering protected routes and redirects signed-out users to
 * sign-in.
 */
export function Protected() {
  const session = useQuery(sessionOptions());
  const client = useQueryClient();
  const pathname = useLocation({ select: (location) => location.pathname });
  useEffect(() => {
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ['private'] });
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', restore);

    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', restore);
    };
  }, [client]);
  useEffect(() => {
    void client.invalidateQueries({ queryKey: ['private', 'session'] });
  }, [client, pathname]);
  useLanguageSync(session.data?.user.id, !!session.data?.supportView);
  if (session.isError)
    return (
      <Failure error={session.error} retry={() => void session.refetch()} />
    );
  if (session.isPending) return <Pending />;
  if (!session.data) return <SignInRedirect />;

  return <Outlet key={session.data.sessionId} />;
}
