import type { InstalledConnection } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { actorLabel } from '@luma/ui/lib/actor';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { activityLabel } from '../activity/presentation';
import { RelativeTime } from './presentation';

const api = createWebApiClient();

// Activity reads at most a year at once; older events stay in Activity.
const historyWindowMs = 365 * 24 * 60 * 60 * 1000;
const recentEvents = 5;

/**
 * Reads a connection's most recent lifecycle events from Activity, newest first, within the
 * last year or since the connection was added. Connection events are restricted, so only
 * people who may read restricted activity see them.
 */
function connectionHistoryOptions(
  organizationId: string,
  connection: Pick<InstalledConnection, 'id' | 'createdAt'>,
) {
  return queryOptions({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'activity',
      'connection',
      connection.id,
    ],
    ...privateQueryDefaults,
    queryFn: ({ signal }) => {
      const to = Date.now();
      const from = Math.max(
        to - historyWindowMs,
        Math.min(Date.parse(connection.createdAt), to - 60_000),
      );

      return api.activity.list(
        {
          params: { organizationId },
          query: {
            view: 'events',
            detail: 'summary',
            from: new Date(from).toISOString(),
            to: new Date(to).toISOString(),
            connectionId: connection.id,
            limit: recentEvents,
          },
        },
        { signal },
      );
    },
  });
}

/**
 * Shows who added, checked, renamed, reconnected or disconnected a connection and when. Reads
 * only when opened, so a page with many connections doesn't read every history up front.
 */
export function ConnectionHistory({
  organizationId,
  connection,
}: {
  organizationId: string;
  connection: InstalledConnection;
}) {
  const [open, setOpen] = useState(false);
  const history = useQuery({
    ...connectionHistoryOptions(organizationId, connection),
    enabled: open,
  });

  return (
    <Disclosure
      className="connection-history-log"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{m.connections_history_title()}</summary>
      {!open ? null : history.isPending ? (
        <p role="status" className="connection-feedback">
          {m.connections_history_loading()}
        </p>
      ) : history.error ? (
        <p role="alert" className="connection-feedback">
          {m.connections_history_failed()}
        </p>
      ) : history.data.items.length ? (
        <ol>
          {history.data.items.map((event) => (
            <li key={event.id}>
              <span>{activityLabel(event.action)}</span>
              <span className="connection-history-meta">
                {actorLabel(event.actor, { email: false })} ·{' '}
                <RelativeTime value={event.recordedAt} />
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="connection-feedback">{m.connections_history_empty()}</p>
      )}
      {open ? (
        <Link
          className="connection-history-all"
          to="/app/$organizationId/activity"
          params={{ organizationId }}
          search={{ connectionId: connection.id }}
        >
          {m.connections_history_all()}
        </Link>
      ) : null}
    </Disclosure>
  );
}
