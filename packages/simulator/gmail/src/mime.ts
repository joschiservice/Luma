import { formatAddress, type MailAddress } from './model.js';

export interface Header {
  name: string;
  value: string;
}

/** A parsed MIME entity: a leaf with decoded bytes or a multipart container. */
export interface MimePart {
  headers: Header[];
  mimeType: string;
  params: Record<string, string>;
  filename: string | null;
  disposition: string | null;
  /** Decoded content of a leaf part. */
  content: Buffer;
  parts: MimePart[];
}

/** A malformed message Gmail would reject with 400. */
export class MimeError extends Error {}

/** Reads one header value, case-insensitively. */
export const header = (headers: Header[], name: string) =>
  headers.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value;

/** Decodes RFC 2047 encoded words such as `=?UTF-8?B?...?=`. */
function decodeWords(value: string) {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
      (_, charset: string, encoding: string, text: string) => {
        const bytes =
          encoding.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : Buffer.from(
                text
                  .replace(/_/g, ' ')
                  .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
                    String.fromCharCode(parseInt(hex, 16)),
                  ),
                'latin1',
              );

        return new TextDecoder(charset.toLowerCase()).decode(bytes);
      },
    );
}

/** Encodes a header value as one UTF-8 encoded word when it is not plain ASCII. */
export const encodeWord = (value: string) =>
  /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

function splitHeaders(raw: string) {
  const match = /\r?\n\r?\n/.exec(raw);
  const head = match ? raw.slice(0, match.index) : raw;
  const body = match ? raw.slice(match.index + match[0].length) : '';
  const headers: Header[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length) {
      headers[headers.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      if (line.trim()) throw new MimeError('Invalid header line');
      continue;
    }
    headers.push({
      name: line.slice(0, colon).trim(),
      value: line.slice(colon + 1).trim(),
    });
  }

  return { headers, body };
}

/** Splits `type/subtype; key=value` into its value and lower-cased parameters. */
function parameters(value: string | undefined) {
  const [first = '', ...rest] = (value ?? '').split(';');
  const params: Record<string, string> = {};
  for (const item of rest) {
    const equals = item.indexOf('=');
    if (equals < 0) continue;
    params[item.slice(0, equals).trim().toLowerCase()] = decodeWords(
      item
        .slice(equals + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1'),
    );
  }

  return { value: first.trim().toLowerCase(), params };
}

function decodeBody(body: string, encoding: string | undefined) {
  switch ((encoding ?? '7bit').trim().toLowerCase()) {
    case 'base64':
      return Buffer.from(body.replace(/\s+/g, ''), 'base64');
    case 'quoted-printable':
      return Buffer.from(
        body
          .replace(/=\r?\n/g, '')
          .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
            String.fromCharCode(parseInt(hex, 16)),
          ),
        'latin1',
      );
    default:
      return Buffer.from(body, 'utf8');
  }
}

/** Parses an RFC 5322 message or MIME entity, including nested multiparts. */
export function parseMime(raw: string): MimePart {
  const { headers, body } = splitHeaders(raw);
  const type = parameters(header(headers, 'content-type') ?? 'text/plain');
  const disposition = parameters(header(headers, 'content-disposition'));
  const filename = disposition.params.filename ?? type.params.name ?? null;
  const part: MimePart = {
    headers,
    mimeType: type.value || 'text/plain',
    params: type.params,
    filename,
    disposition: disposition.value || null,
    content: Buffer.alloc(0),
    parts: [],
  };
  if (part.mimeType.startsWith('multipart/')) {
    const boundary = type.params.boundary;
    if (!boundary) throw new MimeError('Multipart message without boundary');
    const sections = body.split(`--${boundary}`);
    for (const section of sections.slice(1)) {
      if (section.startsWith('--')) break;
      part.parts.push(parseMime(section.replace(/^\r?\n/, '')));
    }

    return part;
  }
  part.content = decodeBody(
    body.replace(/\r?\n$/, ''),
    header(headers, 'content-transfer-encoding'),
  );

  return part;
}

/** Parses an address list such as `"Name" <a@b>, c@d`; ignores group syntax. */
export function parseAddresses(value: string | undefined): MailAddress[] {
  if (!value) return [];
  const result: MailAddress[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const char of `${decodeWords(value)},`) {
    if (char === '"') quoted = !quoted;
    if (char === '<' && !quoted) angle = true;
    if (char === '>' && !quoted) angle = false;
    if (char === ',' && !quoted && !angle) {
      const item = current.trim();
      current = '';
      if (!item) continue;
      const match = /^(.*)<([^>]+)>\s*$/.exec(item);
      const address = (match ? match[2]! : item).trim().toLowerCase();
      const name = match ? match[1]!.trim().replace(/^"(.*)"$/, '$1') : '';
      if (address.includes('@')) result.push({ address, name: name || null });
      continue;
    }
    current += char;
  }

  return result;
}

/** Splits a References or In-Reply-To header into bare Message-IDs. */
export const messageIds = (value: string | undefined) =>
  (value ?? '').match(/<[^<>\s]+>/g)?.map((id) => id.slice(1, -1)) ??
  (value?.trim() ? [value.trim()] : []);

/** Collects the first text/plain and text/html bodies and the attachments of a message. */
export function contents(part: MimePart) {
  let text: string | null = null;
  let html: string | null = null;
  const attachments: { filename: string; mimeType: string; content: Buffer }[] =
    [];
  const visit = (node: MimePart) => {
    if (node.parts.length) {
      node.parts.forEach(visit);

      return;
    }
    if (node.filename || node.disposition === 'attachment') {
      attachments.push({
        filename: node.filename ?? 'attachment',
        mimeType: node.mimeType,
        content: node.content,
      });

      return;
    }
    const decoded = new TextDecoder(node.params.charset ?? 'utf-8').decode(
      node.content,
    );
    if (node.mimeType === 'text/plain' && text === null) text = decoded;
    else if (node.mimeType === 'text/html' && html === null) html = decoded;
  };
  visit(part);

  return { text, html, attachments };
}

const wrap = (base64: string) => base64.replace(/.{1,76}/g, '$&\r\n');

/** Builds an RFC 5322 message with a text body, optional HTML and attachments. */
export function buildMime(input: {
  headers: Header[];
  text: string;
  html: string | null;
  attachments: { filename: string; mimeType: string; base64: string }[];
  boundary: string;
}) {
  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(input.text, 'utf8').toString('base64')),
  ].join('\r\n');
  const htmlPart =
    input.html === null
      ? null
      : [
          'Content-Type: text/html; charset="UTF-8"',
          'Content-Transfer-Encoding: base64',
          '',
          wrap(Buffer.from(input.html, 'utf8').toString('base64')),
        ].join('\r\n');
  const alternative = htmlPart
    ? [
        `Content-Type: multipart/alternative; boundary="${input.boundary}-alt"`,
        '',
        `--${input.boundary}-alt`,
        textPart,
        `--${input.boundary}-alt`,
        htmlPart,
        `--${input.boundary}-alt--`,
        '',
      ].join('\r\n')
    : textPart;
  const body = input.attachments.length
    ? [
        `Content-Type: multipart/mixed; boundary="${input.boundary}"`,
        '',
        `--${input.boundary}`,
        alternative,
        ...input.attachments.flatMap((attachment) => [
          `--${input.boundary}`,
          [
            `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
            `Content-Disposition: attachment; filename="${attachment.filename}"`,
            'Content-Transfer-Encoding: base64',
            '',
            wrap(attachment.base64),
          ].join('\r\n'),
        ]),
        `--${input.boundary}--`,
        '',
      ].join('\r\n')
    : alternative;

  return [
    ...input.headers.map((item) => `${item.name}: ${item.value}`),
    'MIME-Version: 1.0',
    body,
  ].join('\r\n');
}

/** Formats an address list header value. */
export const addressList = (addresses: MailAddress[]) =>
  addresses
    .map((address) =>
      address.name && encodeWord(address.name) !== address.name
        ? `${encodeWord(address.name)} <${address.address}>`
        : formatAddress(address),
    )
    .join(', ');
