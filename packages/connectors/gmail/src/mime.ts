import { convertHtml } from './html.js';
import type { GmailMessage, MessagePart } from './schemas.js';

/** Longest message text returned; longer bodies are cut and marked truncated. */
export const maxTextLength = 100_000;

export interface ParsedAddress {
  /** Lower-case address. */
  address: string;
  name: string | null;
}

export interface ParsedAttachment {
  /** Gmail part ID: stable for the message, unlike Gmail attachment IDs. */
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * Whether the receiving system authenticated the From domain: `aligned` when its DMARC check
 * passed for exactly that domain, `unaligned` when it checked and did not, `unknown` when it
 * left no result (such as messages the mailbox sent).
 */
type SenderAuthentication = 'aligned' | 'unaligned' | 'unknown';

/** A Gmail message normalized into mailbox-independent fields. */
export interface ParsedMessage {
  /** A structured permanent delivery failure; normal message text is never a bounce signal. */
  deliveryFailure?: {
    originalMessageId: string;
    recipient: string;
    status: string;
  };
  id: string;
  threadId: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  direction: 'inbound' | 'outbound';
  /** True only when provider-owned metadata confirms a sent message. */
  providerSent?: boolean;
  from: ParsedAddress;
  /** What Gmail's own Authentication-Results header says about the From domain. */
  senderAuthentication: SenderAuthentication;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  replyTo: ParsedAddress[];
  /** Delivered-To addresses, for matching aliases delivered to the mailbox. */
  deliveredTo: string[];
  subject: string;
  text: string;
  truncated: boolean;
  sentAt: string;
  receivedAt: string;
  labels: string[];
  attachments: ParsedAttachment[];
}

/** Decodes base64 or base64url text, ignoring whitespace. */
export function decodeBase64(data: string): Buffer {
  return Buffer.from(data.replace(/\s+/g, ''), 'base64url');
}

/** Decodes bytes in the named charset; unknown or missing charsets fall back to UTF-8. */
function decodeCharset(bytes: Uint8Array, charset: string | null): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/\*.*$/, '');
  try {
    return new TextDecoder(label === 'latin1' ? 'iso-8859-1' : label).decode(
      bytes,
    );
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Decodes RFC 2047 encoded words; whitespace between adjacent encoded words is dropped. */
export function decodeWords(value: string): string {
  return value
    .replace(
      /(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g,
      '$1',
    )
    .replace(
      /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g,
      (match, charset: string, encoding: string, text: string) => {
        try {
          const bytes =
            encoding.toUpperCase() === 'B'
              ? decodeBase64(text)
              : Buffer.from(
                  text
                    .replace(/_/g, ' ')
                    .replace(/=([0-9a-fA-F]{2})/g, (_m, hex: string) =>
                      String.fromCharCode(parseInt(hex, 16)),
                    ),
                  'latin1',
                );

          return decodeCharset(bytes, charset);
        } catch {
          return match;
        }
      },
    );
}

/** Splits at commas outside quotes, comments and angle brackets. */
function splitList(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quoted = false;
  let depth = 0;
  let angle = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quoted) {
      current += char;
      if (char === '\\' && i + 1 < value.length) current += value[++i];
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '(') depth++;
    else if (char === ')' && depth) depth--;
    else if (char === '<') angle = true;
    else if (char === '>') angle = false;
    else if ((char === ',' || char === ';') && !depth && !angle) {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  items.push(current);

  return items;
}

const addressPattern = /^[^\s@<>()",;:\\]{1,64}@[^\s@<>()",;:\\]{1,253}$/;

const unquote = (value: string) =>
  value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1).replace(/\\(.)/g, '$1')
    : value;

/**
 * Parses an RFC 5322 address list such as `"Doe, Jane" <jane@example.com>, ops@example.com`.
 * Group names are dropped; entries without a valid address are skipped.
 */
export function parseAddressList(value: string | null): ParsedAddress[] {
  if (!value) return [];
  const result: ParsedAddress[] = [];
  for (const raw of splitList(value).slice(0, 500)) {
    // Drop a leading group label such as "Team:".
    let item = raw.trim().replace(/^[^"<@:]*:\s*/, '');
    item = item.replace(/\([^()]*\)/g, ' ').trim();
    if (!item) continue;
    const angle = /<([^<>]*)>\s*$/.exec(item);
    const address = (angle ? angle[1]! : item).trim().toLowerCase();
    if (!addressPattern.test(address)) continue;
    const name = angle
      ? decodeWords(unquote(item.slice(0, angle.index).trim())).trim()
      : '';
    result.push({ address, name: name || null });
  }

  return result;
}

/** Returns the first RFC 5322 message ID in a header, without angle brackets. */
function messageIds(value: string | null): string[] {
  if (!value) return [];

  return [...value.matchAll(/<([^<>\s]{1,998})>/g)].map((match) => match[1]!);
}

function headerOf(part: MessagePart | undefined, name: string): string | null {
  const lower = name.toLowerCase();
  const found = part?.headers?.find((h) => h.name.toLowerCase() === lower);

  return found ? found.value : null;
}

function headersOf(part: MessagePart | undefined, name: string): string[] {
  const lower = name.toLowerCase();

  return (part?.headers ?? [])
    .filter((h) => h.name.toLowerCase() === lower)
    .map((h) => h.value);
}

function contentType(part: MessagePart) {
  const header = headerOf(part, 'Content-Type');
  const charset = header
    ? (/;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(header)?.[1] ?? null)
    : null;

  return { mimeType: (part.mimeType ?? '').toLowerCase(), charset };
}

function isAttachment(part: MessagePart) {
  return (
    !!part.filename?.trim() ||
    /^\s*attachment\b/i.test(headerOf(part, 'Content-Disposition') ?? '')
  );
}

/** Extracts the readable body: plain text preferred, HTML converted when no plain text exists. */
function bodyOf(
  part: MessagePart,
): { text: string; plain: boolean; truncated: boolean } | null {
  const { mimeType, charset } = contentType(part);
  if (mimeType.startsWith('multipart/')) {
    const children = (part.parts ?? [])
      .map(bodyOf)
      .filter(
        (body): body is { text: string; plain: boolean; truncated: boolean } =>
          !!body,
      );
    if (!children.length) return null;
    if (mimeType === 'multipart/alternative')
      return children.find((body) => body.plain) ?? children[0]!;

    return {
      text: children
        .map((body) => body.text)
        .filter(Boolean)
        .join('\n\n'),
      plain: children.every((body) => body.plain),
      truncated: children.some((body) => body.truncated),
    };
  }
  if (isAttachment(part) || !part.body?.data) return null;
  if (mimeType === 'text/plain')
    return {
      text: decodeCharset(decodeBase64(part.body.data), charset).replace(
        /\r\n?/g,
        '\n',
      ),
      plain: true,
      truncated: false,
    };
  if (mimeType === 'text/html')
    return {
      ...convertHtml(decodeCharset(decodeBase64(part.body.data), charset)),
      plain: false,
    };

  return null;
}

/**
 * Describes a part that carries a named attachment, or null for bodies, containers and inline
 * parts without a filename (such as embedded images).
 */
export function describeAttachment(part: MessagePart): ParsedAttachment | null {
  const filename = part.filename?.trim();
  if (
    !filename ||
    (part.mimeType ?? '').toLowerCase().startsWith('multipart/') ||
    !(part.body?.attachmentId || part.body?.data)
  )
    return null;

  return {
    partId: part.partId || 'root',
    filename: decodeWords(filename).slice(0, 255),
    mimeType: (part.mimeType || 'application/octet-stream').toLowerCase(),
    size: part.body.size ?? 0,
  };
}

function attachmentsOf(part: MessagePart, found: ParsedAttachment[] = []) {
  const attachment = describeAttachment(part);
  if (attachment) found.push(attachment);
  for (const child of part.parts ?? []) attachmentsOf(child, found);

  return found;
}

/** Finds a part by the ID {@link parseMessage} reports for its attachment. */
export function findPart(
  part: MessagePart | undefined,
  partId: string,
): MessagePart | null {
  if (!part) return null;
  if ((part.partId || 'root') === partId) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, partId);
    if (found) return found;
  }

  return null;
}

/** Reads permanent failures only from MIME delivery-status reports linked to an original ID. */
function deliveryFailure(
  part: MessagePart | undefined,
): ParsedMessage['deliveryFailure'] {
  if (
    !part ||
    (part.mimeType ?? '').toLowerCase() !== 'multipart/report' ||
    !/report-type\s*=\s*"?delivery-status/i.test(
      headerOf(part, 'Content-Type') ?? '',
    )
  )
    return undefined;
  const status = part.parts?.find(
    (p) => p.mimeType?.toLowerCase() === 'message/delivery-status',
  );
  if (!status?.body?.data) return undefined;
  const report = decodeCharset(decodeBase64(status.body.data), 'utf-8');
  const originalPart = part.parts?.find((p) =>
    ['message/rfc822', 'text/rfc822-headers'].includes(
      p.mimeType?.toLowerCase() ?? '',
    ),
  );
  const original = originalPart?.body?.data
    ? decodeCharset(decodeBase64(originalPart.body.data), 'utf-8')
    : '';
  const originalMessageId = messageIds(
    /^Original-Message-ID:\s*(.+)$/im.exec(report)?.[1] ??
      /^Message-ID:\s*(.+)$/im.exec(original)?.[1] ??
      headerOf(originalPart, 'Message-ID') ??
      headerOf(part, 'In-Reply-To'),
  )[0];
  const recipient = /^Final-Recipient:\s*rfc822;\s*(\S+)$/im
    .exec(report)?.[1]
    ?.toLowerCase();
  const code = /^Status:\s*(5\.\d{1,3}\.\d{1,3})\s*$/im.exec(report)?.[1];
  if (
    !originalMessageId ||
    !recipient ||
    !code ||
    !/^Action:\s*failed\s*$/im.test(report)
  )
    return undefined;

  return { originalMessageId, recipient, status: code };
}

/** The authserv-id Gmail's receiving servers write; results under other IDs are not trusted. */
const trustedAuthServId = 'mx.google.com';

/** Removes RFC 5322 comments, which may nest, while keeping quoted strings intact. */
function stripComments(value: string) {
  let result = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === '\\' && (quoted || depth)) {
      if (!depth) result += char + (value[i + 1] ?? '');
      i++;
    } else if (quoted) {
      result += char;
      if (char === '"') quoted = false;
    } else if (char === '(') depth++;
    else if (char === ')' && depth) depth--;
    else if (!depth) {
      if (char === '"') quoted = true;
      result += char;
    }
  }

  return result;
}

/**
 * The results of one method in an Authentication-Results value, each with the domain named by
 * the first of `properties` it carries (an address such as `header.i=@a.example` gives its
 * domain).
 */
function methodResults(
  results: readonly string[],
  method: 'dmarc' | 'dkim',
  properties: readonly string[],
) {
  return results.flatMap((result) => {
    const [name = '', rest = ''] = result.split(/=(.*)/s);
    if (
      name
        .trim()
        .toLowerCase()
        .replace(/\/\d+$/, '') !== method
    )
      return [];
    const outcome = /^\s*([a-z]+)\b/i.exec(rest)?.[1]?.toLowerCase();
    if (!outcome) return [];
    const found = new Map<string, string>();
    for (const match of rest.matchAll(
      /(?:^|\s)([a-z]+\.[a-z]+)\s*=\s*("[^"]*"|\S+)/gi,
    ))
      if (!found.has(match[1]!.toLowerCase()))
        found.set(match[1]!.toLowerCase(), unquote(match[2]!).toLowerCase());
    const value = properties.map((p) => found.get(p)).find(Boolean);

    return [
      {
        result: outcome,
        domain: value
          ? value.slice(value.lastIndexOf('@') + 1).replace(/\.$/, '')
          : null,
      },
    ];
  });
}

/**
 * Parses an RFC 8601 Authentication-Results value into its authserv-id, the DMARC results with
 * the `header.from` domain each evaluated, and the DKIM results with their signing domain.
 */
function authenticationResults(value: string) {
  const [id = '', ...results] = stripComments(value.replace(/\r?\n/g, ' '))
    .split(';')
    .map((part) => part.trim());

  return {
    authServId: id.split(/\s+/)[0]!.toLowerCase(),
    dmarc: methodResults(results, 'dmarc', ['header.from']),
    dkim: methodResults(results, 'dkim', ['header.d', 'header.i']),
  };
}

/**
 * Reads the topmost Authentication-Results header Gmail's receiving servers added. Headers
 * below it travelled with the message and may be forged by the sender, so they are ignored.
 * Aligned needs exactly one From address whose domain passed DMARC. Mail from the mailbox's
 * own domain, such as a colleague's, may carry no DMARC result; it is also aligned when Gmail
 * verified a DKIM signature by exactly that domain. SPF is never enough: Google's sending
 * servers are shared by every Workspace customer.
 */
function senderAuthentication(
  part: MessagePart | undefined,
  mailbox: string,
): SenderAuthentication {
  const trusted = headersOf(part, 'Authentication-Results')
    .map(authenticationResults)
    .find((result) => result.authServId === trustedAuthServId);
  if (!trusted) return 'unknown';
  const from = parseAddressList(headersOf(part, 'From').join(', '));
  const domain =
    from.length === 1
      ? from[0]!.address.slice(from[0]!.address.lastIndexOf('@') + 1)
      : null;
  if (!domain) return 'unaligned';
  const own = domain === mailbox.toLowerCase().split('@')[1];
  const passed = (results: { result: string; domain: string | null }[]) =>
    results.some(
      (result) => result.result === 'pass' && result.domain === domain,
    );

  return passed(trusted.dmarc) || (own && passed(trusted.dkim))
    ? 'aligned'
    : 'unaligned';
}

const validTime = (value: number) =>
  Number.isFinite(value) && value > 0 && value < 8.64e15;

/**
 * Normalizes a Gmail `format=full` message. `mailbox` is the connected address, which makes
 * a message outbound when it sent it; `labelNames` maps Gmail label IDs to names.
 */
export function parseMessage(
  message: GmailMessage,
  mailbox: string,
  labelNames: ReadonlyMap<string, string> = new Map(),
): ParsedMessage {
  const payload = message.payload;
  const internal = Number(message.internalDate);
  const receivedAt = new Date(validTime(internal) ? internal : 0).toISOString();
  const date = Date.parse(headerOf(payload, 'Date') ?? '');
  const from = parseAddressList(headerOf(payload, 'From'))[0] ?? {
    address: '',
    name: null,
  };
  const labelIds = message.labelIds ?? [];
  const body = payload ? bodyOf(payload) : null;
  const text = body?.text ?? '';

  return {
    ...(deliveryFailure(payload)
      ? { deliveryFailure: deliveryFailure(payload)! }
      : {}),
    id: message.id,
    threadId: message.threadId,
    rfcMessageId: messageIds(headerOf(payload, 'Message-ID'))[0] ?? null,
    inReplyTo: messageIds(headerOf(payload, 'In-Reply-To'))[0] ?? null,
    references: messageIds(headerOf(payload, 'References')).slice(-100),
    direction:
      labelIds.includes('SENT') || from.address === mailbox.toLowerCase()
        ? 'outbound'
        : 'inbound',
    providerSent: labelIds.includes('SENT'),
    from,
    senderAuthentication: senderAuthentication(payload, mailbox),
    to: parseAddressList(headersOf(payload, 'To').join(', ')),
    cc: parseAddressList(headersOf(payload, 'Cc').join(', ')),
    replyTo: parseAddressList(headerOf(payload, 'Reply-To')),
    deliveredTo: parseAddressList(
      headersOf(payload, 'Delivered-To').join(', '),
    ).map((item) => item.address),
    subject: decodeWords(headerOf(payload, 'Subject') ?? '')
      .replace(/[\r\n]+\s*/g, ' ')
      .trim()
      .slice(0, 998),
    text: text.slice(0, maxTextLength),
    truncated: !!body?.truncated || text.length > maxTextLength,
    sentAt: validTime(date) ? new Date(date).toISOString() : receivedAt,
    receivedAt,
    labels: labelIds.map((id) => labelNames.get(id) ?? id),
    attachments: payload ? attachmentsOf(payload) : [],
  };
}
