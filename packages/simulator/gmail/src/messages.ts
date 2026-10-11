import { createHash } from 'node:crypto';

import { addressList, encodeWord, type Header } from './mime.js';
import {
  type AttachmentMeta,
  type AttachmentRecord,
  baseSubject,
  formatAddress,
  type GmailContext,
  kinds,
  type MailAddress,
  type MessageRecord,
  nextHistoryId,
  nextMessageId,
  type ThreadRecord,
  toBase64Url,
} from './model.js';

/** A message about to enter the mailbox, inbound or sent. */
export interface NewMessage {
  headers: Header[];
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  html: string | null;
  attachments: { filename: string; mimeType: string; base64: string }[];
  labelIds: string[];
  internalDate: number;
  /** Thread to join; a new thread starts when null. */
  threadId: string | null;
}

/** Finds a message by its RFC Message-ID, case-insensitively. */
export async function findByMessageId(context: GmailContext, id: string) {
  const page = await context.store.page<MessageRecord>({
    kind: kinds.message,
    key: id.toLowerCase(),
    limit: 1,
  });

  return page.items[0]?.data;
}

/** Lists a thread's messages oldest first. */
export async function threadMessages(context: GmailContext, threadId: string) {
  const page = await context.store.page<MessageRecord>({
    kind: kinds.message,
    parent: threadId,
    limit: 1000,
  });

  return page.items
    .map((item) => item.data)
    .sort(
      (a, b) => a.internalDate - b.internalDate || a.id.localeCompare(b.id),
    );
}

/**
 * Finds the thread a message belongs to by its In-Reply-To and References headers, as Gmail
 * threads conversations: a referenced message in this mailbox with the same base subject.
 */
export async function threadByReferences(
  context: GmailContext,
  references: string[],
  subject: string,
) {
  for (const reference of [...references].reverse()) {
    const message = await findByMessageId(context, reference);
    if (message && baseSubject(message.subject) === baseSubject(subject))
      return message.threadId;
  }

  return null;
}

/** Collapses whitespace and escapes HTML like Gmail's snippets. */
export const snippet = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .replace(
      /[&<>"']/g,
      (char) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[char]!,
    );

/** Formats an RFC 5322 date. */
export const mailDate = (time: number) =>
  new Date(time).toUTCString().replace('GMT', '+0000');

/** Builds the standard headers of a message the simulator composes. */
export function composeHeaders(input: {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  date: number;
  deliveredTo?: string | undefined;
}): Header[] {
  return [
    ...(input.deliveredTo
      ? [{ name: 'Delivered-To', value: input.deliveredTo }]
      : []),
    { name: 'MIME-Version', value: '1.0' },
    { name: 'Date', value: mailDate(input.date) },
    { name: 'Message-ID', value: `<${input.messageId}>` },
    { name: 'Subject', value: encodeWord(input.subject) },
    { name: 'From', value: formatAddress(input.from) },
    { name: 'To', value: addressList(input.to) },
    ...(input.cc.length ? [{ name: 'Cc', value: addressList(input.cc) }] : []),
    ...(input.inReplyTo
      ? [{ name: 'In-Reply-To', value: `<${input.inReplyTo}>` }]
      : []),
    ...(input.references.length
      ? [
          {
            name: 'References',
            value: input.references.map((id) => `<${id}>`).join(' '),
          },
        ]
      : []),
  ];
}

/**
 * Stores a message with its attachments and updates its thread. Returns the stored record.
 * Gmail IDs: the thread ID is the ID of the thread's first message.
 */
export async function storeMessage(context: GmailContext, input: NewMessage) {
  const id = await nextMessageId(context, input.internalDate);
  const threadId = input.threadId ?? id;
  const historyId = await nextHistoryId(context);
  const attachments: AttachmentMeta[] = [];
  for (const [index, attachment] of input.attachments.entries()) {
    const attachmentId = `ANGjdJ${toBase64Url(
      createHash('sha256').update(`${id}:${index}`).digest('base64'),
    )}`;
    const size = Buffer.from(attachment.base64, 'base64').length;
    attachments.push({
      attachmentId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size,
    });
    await context.store.put<AttachmentRecord>(
      kinds.attachment,
      attachmentId,
      { attachmentId, messageId: id, base64: attachment.base64 },
      { parent: id, createdAt: input.internalDate, updatedAt: context.now },
    );
  }
  const message: MessageRecord = {
    id,
    threadId,
    labelIds: input.labelIds,
    internalDate: input.internalDate,
    historyId,
    headers: input.headers,
    messageId: input.messageId,
    inReplyTo: input.inReplyTo,
    references: input.references,
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    html: input.html,
    attachments,
  };
  await context.store.put(kinds.message, id, message, {
    parent: threadId,
    key: input.messageId.toLowerCase(),
    createdAt: input.internalDate,
    updatedAt: context.now,
  });
  const previous = await context.store.get<ThreadRecord>(
    kinds.thread,
    threadId,
  );
  const participants = new Set(previous?.data.participants ?? []);
  for (const address of [input.from, ...input.to, ...input.cc])
    participants.add(address.address);
  const latest = !previous || input.internalDate >= previous.data.lastMessageAt;
  await context.store.put<ThreadRecord>(
    kinds.thread,
    threadId,
    {
      id: threadId,
      subject: previous?.data.subject ?? input.subject,
      snippet: latest ? snippet(input.text) : previous.data.snippet,
      participants: [...participants],
      messageCount: (previous?.data.messageCount ?? 0) + 1,
      lastMessageAt: Math.max(
        previous?.data.lastMessageAt ?? 0,
        input.internalDate,
      ),
      historyId,
    },
    {
      createdAt: previous?.createdAt ?? input.internalDate,
      updatedAt: context.now,
    },
  );
  context.notify({
    topic: input.labelIds.includes('SENT')
      ? 'messages/sent'
      : 'messages/received',
    resource: id,
    payload: { id, threadId, historyId },
  });

  return message;
}
