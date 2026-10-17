/** Message threads: aggregates, reply deadlines and which attachments become documents. */

import type { MailboxRule } from './mailbox.js';

export interface Address {
  address: string;
  name: string | null;
}

export interface AttachmentRef {
  attachment: { externalId: string; scopeKey: string };
  filename: string;
  mimeType: string;
  size: number;
}

/** A provider message as the mailbox holds it; mirrors the `messages.read` snapshot. */
export interface MessageData {
  /** A structured permanent delivery failure; normal message text is never a bounce signal. */
  deliveryFailure?: {
    originalMessageId: string;
    recipient: string;
    status: string;
  };
  thread: { externalId: string; scopeKey: string };
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  direction: 'inbound' | 'outbound';
  /** True only when provider-owned metadata confirms a sent message. */
  providerSent?: boolean;
  from: Address;
  /**
   * Whether the receiving system authenticated the From domain (DMARC aligned). Missing on
   * older messages and means `unknown`; only `aligned` identifies the sender.
   */
  senderAuthentication?: 'aligned' | 'unaligned' | 'unknown';
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  subject: string;
  text: string;
  truncated: boolean;
  sentAt: string;
  receivedAt: string;
  labels: string[];
  attachments: AttachmentRef[];
}

/** The stored snapshot without the text, which is kept separately so it can be removed. */
export type MessageDocument = Omit<MessageData, 'text'> & { digest: string };

export type ThreadStatus = 'open' | 'waiting' | 'closed';

/** Derived thread content kept with the thread for lists. */
export interface ThreadDocument {
  /** The mailbox thread learned by independently reading a newly composed send. */
  resolvedProviderThreadId?: string;
  participants: Address[];
  /** Latest correspondent outside the mailbox. */
  correspondent: Address | null;
  snippet: string;
  attachmentCount: number;
}

export interface ThreadAggregate {
  subject: string;
  document: ThreadDocument;
  lastMessageAt: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  messageCount: number;
}

/** One stored message as aggregation needs it; `text` is null after removal. */
export interface StoredMessage {
  direction: 'inbound' | 'outbound';
  document: Pick<
    MessageDocument,
    'from' | 'to' | 'cc' | 'subject' | 'attachments' | 'receivedAt'
  >;
  text: string | null;
}

const snippetLength = 200;
const participantLimit = 20;

/** Recomputes list fields from every stored message of a thread, oldest first. */
export function aggregateThread(
  messages: readonly StoredMessage[],
): ThreadAggregate | null {
  if (!messages.length) return null;
  const ordered = [...messages].sort((a, b) =>
    a.document.receivedAt.localeCompare(b.document.receivedAt),
  );
  const latest = ordered[ordered.length - 1]!;
  const participants = new Map<string, Address>();
  for (const message of ordered)
    for (const address of [
      message.document.from,
      ...message.document.to,
      ...message.document.cc,
    ])
      if (!participants.has(address.address.toLowerCase()))
        participants.set(address.address.toLowerCase(), address);
  const last = (direction: StoredMessage['direction']) =>
    ordered.filter((m) => m.direction === direction).at(-1)?.document
      .receivedAt ?? null;

  return {
    subject: ordered[0]!.document.subject || latest.document.subject,
    document: {
      participants: [...participants.values()].slice(0, participantLimit),
      correspondent: correspondent(latest),
      snippet: (latest.text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, snippetLength),
      attachmentCount: ordered.reduce(
        (sum, m) => sum + m.document.attachments.length,
        0,
      ),
    },
    lastMessageAt: latest.document.receivedAt,
    lastInboundAt: last('inbound'),
    lastOutboundAt: last('outbound'),
    messageCount: ordered.length,
  };
}

/** The other party of a message: its sender when inbound, its first recipient when sent. */
function correspondent(message: StoredMessage): Address | null {
  return message.direction === 'inbound'
    ? message.document.from
    : (message.document.to[0] ?? message.document.cc[0] ?? null);
}

/**
 * The reply deadline: a person's deadline when set, otherwise the latest unanswered inbound
 * message plus the mailbox's reply hours. A reply newer than the latest inbound message
 * clears the automatic deadline.
 */
export function replyDeadline(input: {
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  manualDueAt: string | null;
  replyHours: number;
}): string | null {
  if (input.manualDueAt) return input.manualDueAt;
  if (!awaitingReply(input)) return null;

  return new Date(
    Date.parse(input.lastInboundAt!) + input.replyHours * 3_600_000,
  ).toISOString();
}

/** An inbound message is newer than the latest reply. */
export function awaitingReply(input: {
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
}) {
  return (
    !!input.lastInboundAt &&
    (!input.lastOutboundAt || input.lastInboundAt > input.lastOutboundAt)
  );
}

/** Largest attachment Luma reads as a document. */
export const maxDocumentBytes = 10 * 1024 * 1024;

const documentTypes: Record<string, string[]> = {
  pdf: ['application/pdf'],
  csv: ['text/csv', 'application/csv'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  txt: ['text/plain'],
};

/**
 * Decides whether an attachment becomes a document to read. Images are not documents; other
 * files are kept as unsupported so people see why nothing was read.
 */
export function documentIntake(
  attachment: Pick<AttachmentRef, 'filename' | 'mimeType' | 'size'>,
):
  | { state: 'pending' }
  | { state: 'unsupported'; failure: 'unsupported_type' | 'too_large' }
  | null {
  const mime = attachment.mimeType.toLowerCase().split(';')[0]!.trim();
  if (mime.startsWith('image/')) return null;
  const extension = /\.([a-z0-9]+)$/i.exec(attachment.filename)?.[1];
  const supported = Object.entries(documentTypes).some(
    ([ext, types]) => types.includes(mime) || extension?.toLowerCase() === ext,
  );
  if (!supported) return { state: 'unsupported', failure: 'unsupported_type' };
  if (attachment.size > maxDocumentBytes)
    return { state: 'unsupported', failure: 'too_large' };

  return { state: 'pending' };
}

/** Trailing markers that distinguish versions of one file rather than different files. */
const versionMarker =
  /(?:[\s_.-]*\(\d+\)|(?:^|[\s_.-]+)(?:v\d+|rev\.?\s?\d+|version\s?\d+|final|copy|kopie|neu|new|updated?|korrigiert|corrected|\d{4}-\d{2}-\d{2}|(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|\d{1,2}\.\d{1,2}\.\d{2,4}))$/;

/**
 * Groups versions of one document within a thread: lower-case name without trailing version
 * markers such as "v2", "(1)", "final", "copy" or a date, keeping the file type.
 */
export function documentFamily(filename: string, threadId: string) {
  const match = /^(.*?)(\.[a-z0-9]{1,8})?$/i.exec(
    filename.trim().toLowerCase(),
  )!;
  let base = match[1] ?? '';
  for (let stripped = base.replace(versionMarker, ''); stripped !== base;)
    [base, stripped] = [stripped, stripped.replace(versionMarker, '')];
  const key =
    base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'document';

  return `${key.slice(0, 400)}${match[2] ?? ''}:${threadId}`;
}

/** Rules that match a message, by sender, recipient or label. Sent messages match by recipient. */
export function matchingRules(
  message: Pick<MessageData, 'direction' | 'from' | 'to' | 'cc' | 'labels'>,
  rules: readonly MailboxRule[],
): { rule: MailboxRule; address: string | null }[] {
  const recipients = [...message.to, ...message.cc].map((a) =>
    a.address.toLowerCase(),
  );
  const correspondents =
    message.direction === 'inbound'
      ? [message.from.address.toLowerCase()]
      : recipients;
  const labels = new Set(message.labels.map((label) => label.toLowerCase()));
  const inDomain = (address: string, domain: string) => {
    const host = address.slice(address.lastIndexOf('@') + 1);

    return host === domain || host.endsWith(`.${domain}`);
  };

  return rules.flatMap((rule) => {
    const value = rule.value.toLowerCase();
    const address =
      rule.kind === 'sender_domain'
        ? correspondents.find((a) => inDomain(a, value))
        : rule.kind === 'sender_address'
          ? correspondents.find((a) => a === value)
          : rule.kind === 'recipient_address'
            ? recipients.find((a) => a === value)
            : labels.has(value)
              ? null
              : undefined;

    return address === undefined ? [] : [{ rule, address }];
  });
}
