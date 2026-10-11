import type { ProviderContext } from '@luma/simulator-core';

/** The simulated mailbox an instance serves until a `seed-mailbox` command replaces it. */
export interface GmailConfig {
  address: string;
  name: string;
}

export type GmailContext = ProviderContext<GmailConfig>;

/** Record kinds in the host table. */
export const kinds = {
  mailbox: 'mailbox',
  message: 'message',
  thread: 'thread',
  attachment: 'attachment',
  label: 'label',
  watch: 'watch',
} as const;

export interface MailAddress {
  address: string;
  name: string | null;
}

/** The stored mailbox identity and its user labels. */
export interface MailboxRecord {
  address: string;
  name: string;
}

export interface LabelRecord {
  id: string;
  name: string;
}

export interface AttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * One message as Gmail stores it. Attachment bytes live in separate records so that searches
 * read only metadata. `headers` keeps the original header order and spelling.
 */
export interface MessageRecord {
  id: string;
  threadId: string;
  labelIds: string[];
  /** Epoch milliseconds when Gmail received or sent the message. */
  internalDate: number;
  historyId: number;
  headers: { name: string; value: string }[];
  /** RFC 5322 Message-ID without angle brackets. */
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
  attachments: AttachmentMeta[];
}

export interface ThreadRecord {
  id: string;
  subject: string;
  snippet: string;
  participants: string[];
  messageCount: number;
  lastMessageAt: number;
  historyId: number;
}

export interface AttachmentRecord {
  attachmentId: string;
  messageId: string;
  /** Standard base64 content. */
  base64: string;
}

export interface WatchRecord {
  topicName: string;
  labelIds: string[];
  historyId: number;
  expiration: number;
}

/** Gmail's system labels; user labels get `Label_<n>` IDs. */
export const systemLabels = [
  'INBOX',
  'SENT',
  'IMPORTANT',
  'UNREAD',
  'STARRED',
  'DRAFT',
  'SPAM',
  'TRASH',
  'CATEGORY_PERSONAL',
  'CATEGORY_UPDATES',
] as const;

/** Reads the seeded mailbox identity, or the instance configuration before seeding. */
export async function mailbox(context: GmailContext): Promise<MailboxRecord> {
  const record = await context.store.get<MailboxRecord>(kinds.mailbox, 'me');

  return record?.data ?? context.config;
}

/** Lists user labels in creation order. */
export async function userLabels(context: GmailContext) {
  const page = await context.store.page<LabelRecord>({
    kind: kinds.label,
    limit: 500,
  });

  return page.items.map((item) => item.data);
}

/** Converts standard base64 to Gmail's unpadded base64url. */
export const toBase64Url = (base64: string) =>
  base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Encodes text as Gmail's base64url body data. */
export const encodeText = (text: string) =>
  toBase64Url(Buffer.from(text, 'utf8').toString('base64'));

/**
 * Allocates a Gmail-style 16-hex-digit message ID that sorts by time and stays unique within the
 * mailbox, as Gmail's IDs do.
 */
export async function nextMessageId(context: GmailContext, at: number) {
  const sequence = await context.store.sequence('message');

  return `${Math.max(0, Math.floor(at)).toString(16).padStart(11, '0').slice(-11)}${(
    sequence % 0x100000
  )
    .toString(16)
    .padStart(5, '0')}`;
}

/** Allocates the next mailbox history ID; every change advances it. */
export const nextHistoryId = (context: GmailContext) =>
  context.store.sequence('history', 1000);

/** Strips angle brackets and whitespace from a Message-ID reference. */
export const bareId = (value: string) =>
  value.trim().replace(/^<+/, '').replace(/>+$/, '');

/** Formats an address for a header, quoting display names that need it. */
export function formatAddress(address: MailAddress) {
  if (!address.name) return address.address;
  const name = /^[\w .-]*$/.test(address.name)
    ? address.name
    : `"${address.name.replace(/["\\]/g, '\\$&')}"`;

  return `${name} <${address.address}>`;
}

/** Removes reply and forward prefixes, so subjects of one conversation compare equal. */
export const baseSubject = (subject: string) =>
  subject
    .replace(/^\s*((re|aw|fwd?|wg)\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
