import type { ProviderRecord, RunDetail } from '@luma/simulator-contract';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { Mail } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';

import { errorMessage } from '../../api';
import { SelectField } from '../../components/fields';
import { LoadError, Loading } from '../../components/query-state';
import { formatCount, formatDateTime } from '../../lib/format';
import { useControl, useRecords } from '../../queries';

const pageSize = 25;

/** The thread fields the panel reads from the mailbox's stored records. */
interface Thread {
  id: string;
  subject: string;
  snippet: string;
  participants: string[];
  messageCount: number;
  lastMessageAt: number;
}

interface Message {
  id: string;
  internalDate: number;
  labelIds: string[];
  from: { address: string; name: string | null };
  to: { address: string; name: string | null }[];
  subject: string;
  text: string;
  attachments: { filename: string; mimeType: string; size: number }[];
}

const address = (value: { address: string; name: string | null }) =>
  value.name ? `${value.name} <${value.address}>` : value.address;

/**
 * The merchant's simulated operations mailbox: threads, their messages and a form that sends
 * mail as a supplier or customer. Luma reads the same mailbox through its Gmail app.
 */
export function MailboxView({ run }: { run: RunDetail }) {
  const mailbox = run.merchant.mailboxes[0];
  const [thread, setThread] = useState<Thread | null>(null);
  if (!mailbox)
    return (
      <Card>
        <Empty>
          <Mail aria-hidden="true" />
          <h2>This run has no mailbox</h2>
        </Empty>
      </Card>
    );

  return (
    <div className="sim-stack">
      <h2 className="sim-section-title">
        Mailbox <span className="sim-muted">{mailbox.address}</span>
      </h2>
      <p className="sim-muted">
        Luma reads this mailbox by polling. Gmail push notifications are not
        simulated.
      </p>
      <div className="sim-two-column">
        <Threads
          runId={run.id}
          instance={mailbox.instance}
          selected={thread?.id ?? null}
          onSelect={setThread}
        />
        {thread ? (
          <ThreadMessages
            runId={run.id}
            instance={mailbox.instance}
            thread={thread}
          />
        ) : (
          <Card>
            <Empty>
              <Mail aria-hidden="true" />
              <h3>Select a thread to read its messages</h3>
            </Empty>
          </Card>
        )}
      </div>
      <SendMail run={run} instance={mailbox.instance} thread={thread} />
    </div>
  );
}

function Threads({
  runId,
  instance,
  selected,
  onSelect,
}: {
  runId: string;
  instance: string;
  selected: string | null;
  onSelect: (thread: Thread) => void;
}) {
  // Cursors of the pages before the current one; the last entry opens the current page.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const after = cursors.at(-1);
  const records = useRecords(runId, instance, {
    kind: 'thread',
    limit: pageSize,
    ...(after ? { after } : {}),
  });
  const columns: DataTableColumn<ProviderRecord>[] = [
    {
      key: 'subject',
      header: 'Thread',
      cell: (record) => {
        const thread = record.data as Thread;

        return (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={selected === thread.id}
            onClick={() => onSelect(thread)}
          >
            {thread.subject || '(no subject)'}
          </Button>
        );
      },
    },
    {
      key: 'participants',
      header: 'Participants',
      hideOnNarrow: true,
      cell: (record) => (record.data as Thread).participants.join(', '),
    },
    {
      key: 'messages',
      header: 'Messages',
      cell: (record) => (
        <span className="lu-numeric">
          {formatCount((record.data as Thread).messageCount)}
        </span>
      ),
    },
    {
      key: 'last',
      header: 'Last message',
      hideOnNarrow: true,
      cell: (record) => (
        <span className="lu-numeric">
          {formatDateTime((record.data as Thread).lastMessageAt)}
        </span>
      ),
    },
  ];

  return (
    <Card as="section" aria-labelledby="threads-title">
      <CardHeader>
        <div>
          <CardTitle id="threads-title">Threads</CardTitle>
          <CardDescription>Newest conversations first.</CardDescription>
        </div>
      </CardHeader>
      {records.isPending ? (
        <Loading label="Loading threads" />
      ) : records.isError ? (
        <LoadError
          title="Threads unavailable"
          error={records.error}
          onRetry={() => void records.refetch()}
        />
      ) : (
        <>
          <DataTable
            caption="Mailbox threads"
            columns={columns}
            rows={records.data.items}
            rowKey={(record) => record.id}
            density="compact"
            variant="plain"
            empty={<p className="sim-muted">The mailbox has no mail yet.</p>}
          />
          <Pagination
            count={records.data.items.length}
            offset={(cursors.length - 1) * pageSize}
            pageSize={pageSize}
            hasNext={records.data.next !== null}
            disabled={records.isFetching && records.isPlaceholderData}
            emptyLabel="No threads"
            label="Thread pages"
            onPrevious={
              cursors.length > 1
                ? () => setCursors((list) => list.slice(0, -1))
                : undefined
            }
            onNext={() => {
              const next = records.data.next;
              if (next) setCursors((list) => [...list, next]);
            }}
          />
        </>
      )}
    </Card>
  );
}

function ThreadMessages({
  runId,
  instance,
  thread,
}: {
  runId: string;
  instance: string;
  thread: Thread;
}) {
  const records = useRecords(runId, instance, {
    kind: 'message',
    parent: thread.id,
    limit: 100,
  });
  const messages = (records.data?.items ?? [])
    .map((record) => record.data as Message)
    .sort((a, b) => a.internalDate - b.internalDate);

  return (
    <Card as="section" aria-labelledby="thread-title">
      <CardHeader>
        <div>
          <CardTitle id="thread-title">
            {thread.subject || '(no subject)'}
          </CardTitle>
          <CardDescription>
            {formatCount(thread.messageCount)} messages, oldest first.
          </CardDescription>
        </div>
      </CardHeader>
      {records.isPending ? (
        <Loading label="Loading messages" />
      ) : records.isError ? (
        <LoadError
          title="Messages unavailable"
          error={records.error}
          onRetry={() => void records.refetch()}
        />
      ) : (
        <ol className="sim-mail-list">
          {messages.map((message) => (
            <li key={message.id} className="sim-mail">
              <div className="sim-mail-meta">
                <strong>{address(message.from)}</strong>
                <span className="sim-muted lu-numeric">
                  {formatDateTime(message.internalDate)}
                </span>
                {message.labelIds.includes('SENT') ? (
                  <Badge tone="info">Sent</Badge>
                ) : (
                  <Badge>Received</Badge>
                )}
              </div>
              <p className="sim-muted">
                To {message.to.map(address).join(', ')}
              </p>
              <p className="sim-mail-body">{message.text}</p>
              {message.attachments.length ? (
                <ul aria-label="Attachments" className="sim-muted">
                  {message.attachments.map((attachment) => (
                    <li key={attachment.filename}>
                      {attachment.filename} · {attachment.mimeType} ·{' '}
                      <span className="lu-numeric">
                        {formatCount(attachment.size)}
                      </span>{' '}
                      bytes
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

type Sender = 'supplier' | 'customer' | 'other';

const senders: Record<Sender, { address: string; name: string }> = {
  supplier: { address: 'orders1@supplier.example', name: 'Supplier' },
  customer: { address: 'kunde@customer.example', name: 'Customer' },
  other: { address: '', name: '' },
};

const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Delivers a message from an external sender, optionally as a reply in the selected thread. */
function SendMail({
  run,
  instance,
  thread,
}: {
  run: RunDetail;
  instance: string;
  thread: Thread | null;
}) {
  const control = useControl(run.id);
  const id = useId();
  const [sender, setSender] = useState<Sender>('supplier');
  const [from, setFrom] = useState(senders.supplier.address);
  const [name, setName] = useState(senders.supplier.name);
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [reply, setReply] = useState<'new' | 'reply'>('new');
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const replying = reply === 'reply' && thread !== null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!emailPattern.test(from.trim())) {
      setProblem('Enter the sender’s email address.');

      return;
    }
    if (!text.trim()) {
      setProblem('Write the message text.');

      return;
    }
    if (!replying && !subject.trim()) {
      setProblem('A new conversation needs a subject.');

      return;
    }
    setProblem(null);
    setSent(false);
    control.mutate(
      {
        action: 'command',
        instance,
        command: {
          kind: 'deliver',
          from: {
            address: from.trim(),
            ...(name.trim() ? { name: name.trim() } : {}),
          },
          ...(subject.trim() ? { subject: subject.trim() } : {}),
          text,
          ...(replying ? { threadOf: thread.id } : {}),
        },
      },
      {
        onSuccess: () => {
          setSent(true);
          setText('');
        },
      },
    );
  }

  return (
    <Card as="section" aria-labelledby={`${id}-title`}>
      <CardHeader>
        <div>
          <CardTitle id={`${id}-title`}>Send mail to the mailbox</CardTitle>
          <CardDescription>
            Mail from a supplier or customer arrives in the inbox at the run’s
            current time.
          </CardDescription>
        </div>
      </CardHeader>
      <form className="sim-form" onSubmit={submit} noValidate>
        <div className="sim-field-grid">
          <SelectField<Sender>
            label="Send as"
            value={sender}
            options={[
              { value: 'supplier', label: 'Supplier' },
              { value: 'customer', label: 'Customer' },
              { value: 'other', label: 'Someone else' },
            ]}
            onChange={(value) => {
              setSender(value);
              setFrom(senders[value].address);
              setName(senders[value].name);
            }}
          />
          <Field>
            <FieldLabel htmlFor={`${id}-from`}>Sender address</FieldLabel>
            <Input
              id={`${id}-from`}
              type="email"
              value={from}
              spellCheck={false}
              onChange={(event) => setFrom(event.currentTarget.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Sender name</FieldLabel>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </Field>
          <SelectField<'new' | 'reply'>
            label="Conversation"
            value={thread ? reply : 'new'}
            options={[
              { value: 'new', label: 'New thread' },
              ...(thread
                ? [
                    {
                      value: 'reply' as const,
                      label: `Reply in “${thread.subject || 'selected thread'}”`,
                    },
                  ]
                : []),
            ]}
            onChange={setReply}
          />
        </div>
        <Field>
          <FieldLabel htmlFor={`${id}-subject`}>Subject</FieldLabel>
          <Input
            id={`${id}-subject`}
            value={subject}
            aria-describedby={`${id}-subject-hint`}
            onChange={(event) => setSubject(event.currentTarget.value)}
          />
          <FieldDescription id={`${id}-subject-hint`}>
            Quote an order or purchase-order number, such as #DE1001 or
            BE-00042, so Luma can link the thread. Replies default to “Re:” and
            the thread’s subject.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-text`}>Message</FieldLabel>
          <Textarea
            id={`${id}-text`}
            value={text}
            rows={5}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </Field>
        <div aria-live="polite">
          {problem || control.isError ? (
            <p className="sim-error-text" role="alert">
              {problem ?? `Not delivered: ${errorMessage(control.error)}`}
            </p>
          ) : sent ? (
            <p>Delivered. Luma sees it on its next mailbox read.</p>
          ) : null}
        </div>
        <div className="sim-actions">
          <Button type="submit" disabled={control.isPending}>
            {control.isPending ? 'Delivering…' : 'Deliver mail'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
