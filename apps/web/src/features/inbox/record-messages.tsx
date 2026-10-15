import './inbox.css';

import type { ThreadSummary } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { usePermissions } from '../../kit/identity/permissions';
import type { RecordMessagesProps } from '../../kit/record-messages';
import { readFailure, recordThreadsOptions } from './data';
import {
  correspondentLabel,
  dueState,
  statusLabels,
  statusStates,
} from './presentation';

/** Lists message threads linked to a record, newest first, with their status and reply deadline. */
export function RecordThreadList({
  organizationId,
  threads,
  loading = false,
  error,
}: {
  organizationId: string;
  threads: readonly ThreadSummary[] | undefined;
  loading?: boolean;
  error?: string | undefined;
}) {
  if (loading)
    return (
      <p role="status" className="messaging-muted">
        {m.messaging_record_loading()}
      </p>
    );
  if (error)
    return (
      <p role="alert" className="messaging-muted">
        {error}
      </p>
    );
  if (!threads?.length)
    return <p className="messaging-muted">{m.messaging_record_empty()}</p>;

  return (
    <ul className="messaging-record-threads">
      {threads.map((thread) => {
        const due = dueState(thread);

        return (
          <li key={thread.id}>
            <Link
              to="/app/$organizationId/inbox"
              params={{ organizationId }}
              search={{ thread: thread.id, view: 'all' }}
            >
              {thread.subject || m.messaging_subject_none()}
            </Link>
            <span className="messaging-muted">
              {correspondentLabel(thread)} ·{' '}
              <WorkspaceDate value={thread.lastMessageAt} />
            </span>
            <span className="messaging-record-thread-state">
              <StatePill state={statusStates[thread.status]}>
                {statusLabels[thread.status]()}
              </StatePill>
              {due === 'overdue' ? (
                <Badge tone="danger">{m.messaging_due_overdue()}</Badge>
              ) : due === 'due' && thread.replyDueAt ? (
                <Badge>
                  {m.messaging_record_due()}{' '}
                  <WorkspaceDate value={thread.replyDueAt} />
                </Badge>
              ) : null}
              {thread.awaitingReply ? (
                <Badge tone="info">{m.messaging_row_awaiting_reply()}</Badge>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Shows a record's message threads inside the record page's own section frame. Renders nothing
 * for people who can't read messages, so record pages don't show an inaccessible panel.
 */
export function RecordMessages({
  organizationId,
  kind,
  recordId,
  frame,
}: RecordMessagesProps) {
  const { can, ready } = usePermissions(organizationId);
  const allowed = ready && can('messages.read');
  const query = useQuery({
    ...recordThreadsOptions(organizationId, kind, recordId),
    enabled: allowed,
  });
  const failure = readFailure(query.error);
  if (!allowed || failure === 'access' || failure === 'signin') return null;

  return frame(
    <RecordThreadList
      organizationId={organizationId}
      threads={query.data?.items}
      loading={query.isPending}
      error={failure ? m.messaging_record_failed() : undefined}
    />,
    !failure && query.data?.items.length === 0,
  );
}
