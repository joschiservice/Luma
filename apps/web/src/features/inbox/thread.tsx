import type {
  DocumentSummary,
  Message,
  ThreadDetail as ThreadDetailData,
  ThreadStatus,
  ThreadSummary,
} from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { CaseNotice } from '@luma/ui/components/issues/case-investigation';
import { IssuePanelClose } from '@luma/ui/components/issues/issue-panel-close';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Input } from '@luma/ui/components/primitives/input';
import { PersonPicker } from '@luma/ui/components/primitives/person-picker';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import {
  formatWorkspaceDateTime,
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { workspaceDateValue, workspaceInstant } from '@luma/ui/lib/timezone';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowDownLeft, ArrowUpRight, Paperclip } from 'lucide-react';
import { type ReactNode, useContext, useId, useState } from 'react';

import { SignInRedirect } from '../../kit/identity/common';
import { usePermissions } from '../../kit/identity/permissions';
import { CommandFeedback } from './command-feedback';
import { Replies } from './composer';
import {
  addNote,
  assignThread,
  readFailure,
  removeMessageText,
  setDeadline,
  setStatus,
  threadOptions,
  useInboxCommand,
} from './data';
import { LinkedRecords } from './links';
import { type Member, useMembers } from './people';
import {
  actorName,
  addressLabel,
  documentStateLabels,
  documentStates,
  dueState,
  eventText,
  fileSize,
  statusLabels,
  statusStates,
} from './presentation';

type People = {
  members: readonly Member[];
  self: string | undefined;
  name: (id: string) => string;
};

const statuses: ThreadStatus[] = ['open', 'waiting', 'closed'];

/** What the reader may do on a thread: the server's flags narrowed by the reader's role. */
export function threadAccess(
  detail: Pick<ThreadDetailData, 'permissions'>,
  can: (permission: string) => boolean,
) {
  return {
    manage: detail.permissions.canManage && can('messages.manage'),
    send: detail.permissions.canSend && can('messages.send'),
    approve: can('decisions.respond'),
  };
}

/** Loads one thread and shows it in the inbox's detail pane with its work controls. */
export function ThreadDetail({
  organizationId,
  threadId,
  people,
  now,
  onClose,
  navigation,
}: {
  organizationId: string;
  threadId: string;
  people: People;
  now: number;
  onClose: () => void;
  navigation?: ReactNode;
}) {
  const query = useQuery(threadOptions(organizationId, threadId));
  const { can } = usePermissions(organizationId);
  const failure = readFailure(query.error);
  if (failure === 'signin') return <SignInRedirect />;

  if (!query.data)
    return query.isPending ? (
      <div className="messaging-loading" role="status">
        <span className="sr-only">{m.messaging_loading_thread()}</span>
        <span className="lu-skeleton" />
        <span className="lu-skeleton" />
      </div>
    ) : (
      <div className="inbox-placeholder">
        <h2>
          {failure === 'missing'
            ? m.messaging_thread_missing_title()
            : failure === 'access'
              ? m.messaging_thread_access_title()
              : m.messaging_thread_unavailable_title()}
        </h2>
        <p>
          {failure === 'missing'
            ? m.messaging_thread_missing_text()
            : failure === 'access'
              ? m.messaging_error_access()
              : m.messaging_error_unavailable()}
        </p>
        <Button variant="outline" onClick={onClose}>
          {m.messaging_back_to_list()}
        </Button>
      </div>
    );

  return (
    <ThreadDetailView
      organizationId={organizationId}
      detail={query.data}
      access={threadAccess(query.data, can)}
      stale={!!query.error}
      people={people}
      now={now}
      onClose={onClose}
      navigation={navigation}
    />
  );
}

/**
 * Presents a thread: work controls, messages with their source identity, linked records,
 * replies, internal notes and the timeline.
 */
export function ThreadDetailView({
  organizationId,
  detail,
  access,
  stale = false,
  people,
  now,
  onClose,
  navigation,
}: {
  organizationId: string;
  detail: ThreadDetailData;
  access: { manage: boolean; send: boolean; approve: boolean };
  stale?: boolean;
  people: People;
  now: number;
  onClose: () => void;
  navigation?: ReactNode;
}) {
  const { thread } = detail;
  const due = dueState(thread);
  const documents = new Map(detail.documents.map((doc) => [doc.id, doc]));

  return (
    <article className="messaging-thread" aria-labelledby="thread-subject">
      <div className="issue-panel-header">
        <header className="issue-inspector-header">
          <div className="issue-panel-identity">
            <div className="issue-panel-heading">
              <h2 id="thread-subject">
                {thread.subject || m.messaging_subject_none()}
              </h2>
            </div>
            <div className="issue-panel-status">
              <StatePill state={statusStates[thread.status]}>
                {statusLabels[thread.status]()}
              </StatePill>
              {due === 'overdue' ? (
                <Badge tone="danger">{m.messaging_due_overdue()}</Badge>
              ) : null}
              {thread.awaitingReply ? (
                <Badge tone="info">{m.messaging_row_awaiting_reply()}</Badge>
              ) : null}
              <span className="messaging-muted">{thread.mailboxLabel}</span>
            </div>
          </div>
          <div className="issue-panel-navigation">
            {navigation}
            <IssuePanelClose onClose={onClose} />
          </div>
        </header>
      </div>
      <div className="messaging-thread-content">
        {stale ? (
          <CaseNotice title={m.messaging_thread_stale_title()}>
            {m.messaging_thread_stale_text()}
          </CaseNotice>
        ) : null}
        <WorkControls
          key={thread.revision}
          organizationId={organizationId}
          thread={thread}
          manage={access.manage}
          people={people}
        />
        <section
          className="messaging-section"
          aria-labelledby="thread-messages"
        >
          <h3 id="thread-messages">
            {m.messaging_messages_title({ count: detail.messages.length })}
          </h3>
          <ol className="messaging-messages">
            {detail.messages.map((message) => (
              <MessageItem
                key={message.id}
                organizationId={organizationId}
                message={message}
                documents={documents}
                manage={access.manage}
              />
            ))}
          </ol>
        </section>
        <LinkedRecords
          organizationId={organizationId}
          threadId={thread.id}
          links={detail.links}
          manage={access.manage}
          people={people}
        />
        <Replies
          organizationId={organizationId}
          detail={detail}
          send={access.send}
          approve={access.approve}
          people={people}
        />
        <Notes
          organizationId={organizationId}
          threadId={thread.id}
          notes={detail.notes}
          manage={access.manage}
          people={people}
        />
        <section
          className="messaging-section"
          aria-labelledby="thread-timeline"
        >
          <Disclosure>
            <summary>
              <h3 id="thread-timeline">{m.messaging_timeline_title()}</h3>
            </summary>
            <Timeline detail={detail} people={people} now={now} />
          </Disclosure>
        </section>
      </div>
    </article>
  );
}

/** Owner, status and reply deadline, with controls for people who can manage threads. */
function WorkControls({
  organizationId,
  thread,
  manage,
  people,
  onChanged,
}: {
  organizationId: string;
  thread: ThreadSummary;
  manage: boolean;
  people: People;
  /** Called after a change is saved, such as to refresh a Needs you queue. */
  onChanged?: () => void;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const deadlineId = useId();
  const org = { organizationId };
  const assign = useInboxCommand(
    organizationId,
    (ownerId: string | null, id) =>
      assignThread(org, thread.id, {
        id,
        expectedRevision: thread.revision,
        ownerId,
      }),
    onChanged,
  );
  const status = useInboxCommand(
    organizationId,
    (value: ThreadStatus, id) =>
      setStatus(org, thread.id, {
        id,
        expectedRevision: thread.revision,
        status: value,
      }),
    onChanged,
  );
  const deadline = useInboxCommand(
    organizationId,
    (replyDueAt: string | null, id) =>
      setDeadline(org, thread.id, {
        id,
        expectedRevision: thread.revision,
        replyDueAt,
      }),
    onChanged,
  );
  const [due, setDue] = useState(() =>
    thread.replyDueAt
      ? workspaceDateValue(new Date(thread.replyDueAt), timeZone, true).slice(
          0,
          16,
        )
      : '',
  );
  const [dueError, setDueError] = useState<string>();
  const locked = assign.locked || status.locked || deadline.locked;
  const owner = thread.ownerId ? people.name(thread.ownerId) : null;

  return (
    <section className="messaging-work" aria-label={m.messaging_work_label()}>
      <dl className="messaging-facts">
        <div>
          <dt>{m.messaging_owner()}</dt>
          <dd>
            {owner ?? (
              <span className="messaging-muted">
                {m.messaging_row_unassigned()}
              </span>
            )}
            {manage ? (
              <span className="messaging-inline-actions">
                <PersonPicker
                  label={
                    owner
                      ? m.messaging_owner_change()
                      : m.messaging_owner_assign()
                  }
                  title={m.messaging_owner_picker_title()}
                  disabled={locked}
                  people={people.members
                    .filter((member) => member.userId !== thread.ownerId)
                    .map((member) => ({
                      id: member.userId,
                      name: people.name(member.userId),
                      detail: member.email,
                    }))
                    .sort(
                      (a, b) =>
                        Number(b.id === people.self) -
                        Number(a.id === people.self),
                    )}
                  onSelect={(id) => assign.submit(id)}
                />
                {thread.ownerId ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={locked}
                    onClick={() => assign.submit(null)}
                  >
                    {m.messaging_owner_remove()}
                  </Button>
                ) : null}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{m.messaging_status_label()}</dt>
          <dd>
            {manage ? (
              <Select
                aria-label={m.messaging_status_label()}
                value={thread.status}
                disabled={locked}
                onValueChange={(value) => {
                  if (value && value !== thread.status) status.submit(value);
                }}
                options={statuses.map((value) => ({
                  value,
                  label: statusLabels[value](),
                }))}
              />
            ) : (
              statusLabels[thread.status]()
            )}
          </dd>
        </div>
        <div>
          <dt id={deadlineId}>{m.messaging_deadline_label({ timeZone })}</dt>
          <dd>
            {thread.replyDueAt ? (
              <span>
                <WorkspaceDate value={thread.replyDueAt} />
                {` · ${
                  thread.replyDueSource === 'manual'
                    ? m.messaging_deadline_source_manual()
                    : m.messaging_deadline_source_automatic()
                }`}
                {thread.overdue ? ` · ${m.messaging_due_overdue()}` : ''}
              </span>
            ) : (
              <span className="messaging-muted">
                {m.messaging_deadline_none()}
              </span>
            )}
            {manage ? (
              <form
                className="messaging-inline-actions"
                onSubmit={(event) => {
                  event.preventDefault();
                  setDueError(undefined);
                  try {
                    deadline.submit(workspaceInstant(due, timeZone));
                  } catch (error) {
                    setDueError(
                      error instanceof Error
                        ? error.message
                        : m.messaging_deadline_invalid(),
                    );
                  }
                }}
              >
                <Input
                  type="datetime-local"
                  aria-labelledby={deadlineId}
                  required
                  value={due}
                  disabled={locked}
                  onChange={(event) => setDue(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  type="submit"
                  disabled={locked}
                >
                  {m.messaging_deadline_set()}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  disabled={locked}
                  title={m.messaging_deadline_automatic_hint()}
                  onClick={() => deadline.submit(null)}
                >
                  {m.messaging_deadline_automatic()}
                </Button>
              </form>
            ) : null}
            {dueError ? (
              <span className="messaging-error" role="alert">
                {dueError}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      <CommandFeedback command={assign} />
      <CommandFeedback command={status} />
      <CommandFeedback command={deadline} />
    </section>
  );
}

function Addresses({
  label,
  addresses,
}: {
  label: string;
  addresses: Message['to'];
}) {
  if (!addresses.length) return null;

  return (
    <div>
      <dt>{label}</dt>
      <dd>{formatList(addresses.map(addressLabel))}</dd>
    </div>
  );
}

/**
 * Says when the mailbox provider did not authenticate an inbound sender. A failed check means
 * the From address may be forged; a missing one (such as imported mail) means it could not be
 * checked. Authenticated senders and sent messages show nothing.
 */
function SenderAuthentication({ message }: { message: Message }) {
  if (
    message.senderAuthentication === null ||
    message.senderAuthentication === 'aligned'
  )
    return null;
  const unaligned = message.senderAuthentication === 'unaligned';
  const domain = message.from.address.split('@')[1] ?? message.from.address;

  return (
    <Alert tone={unaligned ? 'warning' : 'neutral'}>
      <AlertTitle>
        {unaligned
          ? m.messaging_sender_unaligned()
          : m.messaging_sender_unknown()}
      </AlertTitle>
      <AlertDescription>
        {unaligned
          ? m.messaging_sender_unaligned_text({ domain })
          : m.messaging_sender_unknown_text()}
      </AlertDescription>
    </Alert>
  );
}

/** One message with sender, recipients, text, attachments and its provider identity. */
function MessageItem({
  organizationId,
  message,
  documents,
  manage,
}: {
  organizationId: string;
  message: Message;
  documents: ReadonlyMap<string, DocumentSummary>;
  manage: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const inbound = message.direction === 'inbound';

  return (
    <li className="messaging-message" data-direction={message.direction}>
      <header className="messaging-message-header">
        <span className="messaging-direction">
          {inbound ? (
            <ArrowDownLeft aria-hidden="true" />
          ) : (
            <ArrowUpRight aria-hidden="true" />
          )}
          {inbound
            ? m.messaging_direction_inbound()
            : m.messaging_direction_outbound()}
        </span>
        {message.origin === 'luma' ? (
          <Badge tone="success">{m.messaging_origin_luma()}</Badge>
        ) : null}
        <span className="messaging-muted">
          <WorkspaceDate value={message.sentAt} />
        </span>
      </header>
      <dl className="messaging-message-meta">
        <div>
          <dt>{m.messaging_from()}</dt>
          <dd>{addressLabel(message.from)}</dd>
        </div>
        <Addresses label={m.messaging_to()} addresses={message.to} />
        <Addresses label={m.messaging_cc()} addresses={message.cc} />
      </dl>
      <SenderAuthentication message={message} />
      {message.text !== null ? (
        <div className="messaging-message-text">{message.text}</div>
      ) : (
        <p className="messaging-removed">
          {message.purgedAt
            ? rich(m.messaging_text_removed_at, {
                date: <WorkspaceDate value={message.purgedAt} />,
              })
            : m.messaging_text_unavailable()}
        </p>
      )}
      {message.truncated && message.text !== null ? (
        <p className="messaging-muted">{m.messaging_text_truncated()}</p>
      ) : null}
      {message.attachments.length ? (
        <ul
          className="messaging-attachments"
          aria-label={m.messaging_attachments_label()}
        >
          {message.attachments.map((attachment, index) => {
            const document = attachment.documentId
              ? documents.get(attachment.documentId)
              : undefined;

            return (
              <li key={`${attachment.filename}:${index}`}>
                <Paperclip aria-hidden="true" />
                {attachment.documentId ? (
                  <Link
                    to="/app/$organizationId/inbox/documents/$documentId"
                    params={{
                      organizationId,
                      documentId: attachment.documentId,
                    }}
                  >
                    {attachment.filename}
                  </Link>
                ) : (
                  <span>{attachment.filename}</span>
                )}
                <span className="messaging-muted">
                  {fileSize(attachment.size)}
                </span>
                {document ? (
                  <StatePill state={documentStates[document.state]}>
                    {documentStateLabels[document.state]()}
                  </StatePill>
                ) : (
                  <span className="messaging-muted">
                    {m.messaging_attachment_not_read()}
                  </span>
                )}
                {document && document.factsToReview > 0 ? (
                  <Badge tone="warning">
                    {m.messaging_row_facts({ count: document.factsToReview })}
                  </Badge>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <Disclosure variant="plain" className="messaging-source">
        <summary>{m.messaging_source_title()}</summary>
        <dl className="messaging-message-meta">
          <div>
            <dt>{m.messaging_source_provider()}</dt>
            <dd>{message.source.provider}</dd>
          </div>
          <div>
            <dt>{m.messaging_source_message_id()}</dt>
            <dd>
              <code>{message.source.messageId}</code>
            </dd>
          </div>
          {message.source.rfcMessageId ? (
            <div>
              <dt>{m.messaging_source_rfc_id()}</dt>
              <dd>
                <code>{message.source.rfcMessageId}</code>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{m.messaging_source_received()}</dt>
            <dd>
              <WorkspaceDate value={message.receivedAt} />
            </dd>
          </div>
          <div>
            <dt>{m.messaging_source_retained()}</dt>
            <dd>
              <WorkspaceDate value={message.retainUntil} precision="day" />
            </dd>
          </div>
        </dl>
        {manage && message.text !== null ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
            {m.messaging_remove_text()}
          </Button>
        ) : null}
      </Disclosure>
      {confirm ? (
        <RemoveTextDialog
          organizationId={organizationId}
          message={message}
          close={() => setConfirm(false)}
        />
      ) : null}
    </li>
  );
}

function RemoveTextDialog({
  organizationId,
  message,
  close,
}: {
  organizationId: string;
  message: Message;
  close: () => void;
}) {
  const command = useInboxCommand(
    organizationId,
    (_: null, id) =>
      removeMessageText({ organizationId }, message.threadId, message.id, id),
    close,
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) close();
      }}
    >
      <DialogContent showCloseButton={!command.locked}>
        <DialogTitle>{m.messaging_remove_text_title()}</DialogTitle>
        <DialogDescription>{m.messaging_remove_text_text()}</DialogDescription>
        <CommandFeedback command={command} />
        <DialogFooter>
          <Button variant="outline" disabled={command.locked} onClick={close}>
            {m.common_cancel()}
          </Button>
          <Button
            variant="destructive"
            disabled={command.isPending}
            onClick={() => command.submit(null)}
          >
            {command.isPending
              ? m.messaging_removing()
              : command.uncertain
                ? m.messaging_retry_same()
                : m.messaging_remove_text()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Internal notes: shared with the team in Luma and never sent to the correspondent. */
function Notes({
  organizationId,
  threadId,
  notes,
  manage,
  people,
}: {
  organizationId: string;
  threadId: string;
  notes: ThreadDetailData['notes'];
  manage: boolean;
  people: People;
}) {
  const [body, setBody] = useState('');
  const command = useInboxCommand(
    organizationId,
    (text: string, id) =>
      addNote({ organizationId }, threadId, { id, body: text }),
    () => setBody(''),
  );

  return (
    <section className="messaging-section" aria-labelledby="thread-notes">
      <h3 id="thread-notes">{m.messaging_notes_title()}</h3>
      <p className="messaging-internal">{m.messaging_notes_internal()}</p>
      {notes.length ? (
        <ol className="messaging-notes">
          {notes.map((note) => (
            <li key={note.id}>
              <p className="messaging-note-meta">
                <strong>{people.name(note.authorId)}</strong>{' '}
                <WorkspaceDate value={note.createdAt} />
              </p>
              <div className="messaging-message-text">{note.body}</div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="messaging-muted">{m.messaging_notes_empty()}</p>
      )}
      {manage ? (
        <form
          className="messaging-note-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim()) command.submit(body.trim());
          }}
        >
          <label>
            <span className="sr-only">{m.messaging_note_label()}</span>
            <Textarea
              value={body}
              maxLength={5000}
              disabled={command.locked}
              placeholder={m.messaging_note_placeholder()}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <CommandFeedback command={command} />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={command.locked || !body.trim()}
          >
            {command.isPending ? m.common_saving() : m.messaging_note_add()}
          </Button>
        </form>
      ) : null}
    </section>
  );
}

/** The thread's audited history: messages, assignments, links, notes and replies. */
function Timeline({
  detail,
  people,
}: {
  detail: ThreadDetailData;
  people: People;
  now: number;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const events = [...detail.events].sort((a, b) =>
    b.occurredAt.localeCompare(a.occurredAt),
  );
  if (!events.length)
    return <p className="messaging-muted">{m.messaging_timeline_empty()}</p>;

  return (
    <ol className="messaging-timeline">
      {events.map((event) => (
        <li key={event.id}>
          <span>
            {eventText(event, {
              name: people.name,
              date: (value) => formatWorkspaceDateTime(value, timeZone),
            })}
          </span>
          <span className="messaging-muted">
            {m.messaging_event_by({
              actor: actorName(event.actor, people.name),
            })}{' '}
            · <WorkspaceDate value={event.occurredAt} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The Needs you review for an overdue reply: the thread's latest message with owner, status and
 * deadline controls, and a link to work the thread in the inbox. Saved changes refresh the queue.
 */
export function ThreadReview({
  organizationId,
  threadId,
  onChange,
}: {
  organizationId: string;
  threadId: string;
  onChange: () => Promise<void>;
}) {
  const query = useQuery(threadOptions(organizationId, threadId));
  const { can } = usePermissions(organizationId);
  const people = useMembers(organizationId);
  const failure = readFailure(query.error);
  if (failure === 'signin') return <SignInRedirect />;
  if (!query.data)
    return query.isPending ? (
      <p role="status">{m.messaging_loading_thread()}</p>
    ) : (
      <p role="alert">
        {failure === 'access'
          ? m.messaging_error_access()
          : failure === 'missing'
            ? m.messaging_thread_missing_text()
            : m.messaging_error_unavailable()}
      </p>
    );
  const detail = query.data;
  const latest = [...detail.messages]
    .filter((message) => message.direction === 'inbound')
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];

  return (
    <div className="messaging-thread-review">
      <p>
        <Link
          to="/app/$organizationId/inbox"
          params={{ organizationId }}
          search={{ thread: threadId, view: 'all' }}
        >
          {detail.thread.subject || m.messaging_subject_none()}
        </Link>
      </p>
      {latest ? (
        <ol className="messaging-messages">
          <MessageItem
            organizationId={organizationId}
            message={latest}
            documents={new Map(detail.documents.map((doc) => [doc.id, doc]))}
            manage={false}
          />
        </ol>
      ) : null}
      <WorkControls
        key={detail.thread.revision}
        organizationId={organizationId}
        thread={detail.thread}
        manage={threadAccess(detail, can).manage}
        people={people}
        onChanged={() => void onChange()}
      />
    </div>
  );
}
