/** An address to write into a header. */
interface ComposeAddress {
  address: string;
  name: string | null;
}

export interface ComposeInput {
  from: ComposeAddress;
  to: ComposeAddress[];
  cc: ComposeAddress[];
  subject: string;
  text: string;
  /** RFC 5322 Message-ID without angle brackets. */
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  date: Date;
  attachments?: { filename: string; mimeType: string; base64: string }[];
}

const atext = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const addressPattern =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const idPattern = /^[\x21-\x3b\x3d\x3f-\x7e]{1,900}$/;

function invalid(): never {
  throw new Error('Invalid outbound message');
}

/**
 * Encodes header text as RFC 2047 UTF-8 base64 words of at most 75 characters, folded onto
 * continuation lines. Code points are never split across words.
 */
export function encodeWords(value: string): string {
  const words: string[] = [];
  let chunk = '';
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk || !words.length) words.push(chunk);

  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`)
    .join('\r\n ');
}

const printable = (value: string) => /^[\x20-\x7e]*$/.test(value);

/** Writes header text as is when it is short printable ASCII, otherwise as encoded words. */
function headerText(value: string) {
  if (/[\r\n]/.test(value)) invalid();

  return printable(value) && value.length <= 900 ? value : encodeWords(value);
}

/** Formats one address, quoting or encoding the display name as needed. */
function formatAddress({ address, name }: ComposeAddress): string {
  if (!addressPattern.test(address)) invalid();
  const display = name?.trim();
  if (!display) return address;
  if (/[\r\n]/.test(display)) invalid();
  const phrase = display
    .split(' ')
    .every((word) => word === '' || atext.test(word))
    ? display
    : printable(display)
      ? `"${display.replace(/(["\\])/g, '\\$1')}"`
      : encodeWords(display);

  return `${phrase} <${address}>`;
}

const addressList = (addresses: ComposeAddress[]) =>
  addresses.map(formatAddress).join(',\r\n ');

const messageId = (id: string) => {
  if (!idPattern.test(id) || !id.includes('@')) invalid();

  return `<${id}>`;
};

/** Formats a date as an RFC 5322 date-time in UTC. */
function formatDate(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000');
}

/** Encodes text as base64 in lines of 76 characters. */
function base64Lines(value: string) {
  return (
    Buffer.from(value)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? ''
  );
}

/**
 * Builds a plain-text UTF-8 RFC 5322 message. Header values with line breaks, invalid addresses
 * or invalid message IDs are rejected, so input cannot inject headers.
 */
export function composeMessage(input: ComposeInput): string {
  if (!input.to.length && !input.cc.length) invalid();
  const headers = [
    `From: ${formatAddress(input.from)}`,
    ...(input.to.length ? [`To: ${addressList(input.to)}`] : []),
    ...(input.cc.length ? [`Cc: ${addressList(input.cc)}`] : []),
    `Subject: ${headerText(input.subject)}`,
    `Date: ${formatDate(input.date)}`,
    `Message-ID: ${messageId(input.messageId)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${messageId(input.inReplyTo)}`] : []),
    ...(input.references.length
      ? [`References: ${input.references.map(messageId).join('\r\n ')}`]
      : []),
    'MIME-Version: 1.0',
  ];
  const text = input.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');

  const body = [
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
  ].join('\r\n');
  if (!input.attachments?.length)
    return `${headers.join('\r\n')}\r\n${body}\r\n`;
  if (input.attachments.length > 10) invalid();
  const boundary = `luma-${Buffer.from(input.messageId).toString('hex')}`;
  const parts = input.attachments.map((attachment) => {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/.test(attachment.filename) ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(attachment.mimeType) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        attachment.base64,
      ) ||
      Buffer.byteLength(attachment.base64, 'base64') > 10 * 1024 * 1024
    )
      invalid();

    return [
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      attachment.base64.match(/.{1,76}/g)?.join('\r\n') ?? '',
    ].join('\r\n');
  });

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    body,
    ...parts,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Encodes a composed message for the Gmail `raw` field. */
export function encodeRaw(message: string): string {
  return Buffer.from(message).toString('base64url');
}
