// Reads raw MIME messages as SES stores them in S3: just enough parsing to find who a message
// was sent to and which links it carries. Not a general MIME parser.

/**
 * Splits a raw message into its unfolded headers, keyed by lowercase name, and its body.
 * @param {string} raw
 */
function splitMessage(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const end = text.indexOf('\n\n');
  const head = end === -1 ? text : text.slice(0, end);
  const body = end === -1 ? '' : text.slice(end + 2);
  /** @type {Map<string, string>} */
  const headers = new Map();
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }

  return { headers, body };
}

/**
 * Decodes a quoted-printable body into UTF-8 text.
 * @param {string} body
 */
function decodeQuotedPrintable(body) {
  const joined = body.replace(/=\n/g, '');
  /** @type {number[]} */
  const bytes = [];
  for (let index = 0; index < joined.length; index++) {
    const hex = joined.slice(index + 1, index + 3);
    if (joined[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      index += 2;
    } else bytes.push(...Buffer.from(joined[index] ?? '', 'utf8'));
  }

  return Buffer.from(bytes).toString('utf8');
}

/**
 * Returns the decoded text of every text/plain and text/html part, walking nested multiparts.
 * @param {string} raw
 * @returns {string[]}
 */
function textParts(raw) {
  const { headers, body } = splitMessage(raw);
  const type = headers.get('content-type') ?? 'text/plain';
  if (/^multipart\//i.test(type)) {
    const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
    if (!boundary) return [];

    return body
      .split(`--${boundary}`)
      .slice(1)
      .filter((part) => !part.startsWith('--'))
      .flatMap((part) => textParts(part.replace(/^\n/, '')));
  }
  if (!/^text\/(plain|html)/i.test(type)) return [];
  const encoding = (
    headers.get('content-transfer-encoding') ?? '7bit'
  ).toLowerCase();
  if (encoding === 'base64')
    return [Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')];
  if (encoding === 'quoted-printable') return [decodeQuotedPrintable(body)];

  return [body];
}

/**
 * Returns the lowercase addresses in a raw message's To header.
 * @param {string} raw
 * @returns {string[]}
 */
export function messageRecipients(raw) {
  const to = splitMessage(raw).headers.get('to') ?? '';

  return [...to.matchAll(/[^\s<>,"]+@[^\s<>,"]+/g)].map(([address]) =>
    address.toLowerCase(),
  );
}

/**
 * Returns the distinct links in a raw message's text and HTML parts that point to `origin`.
 * Links to any other origin are dropped, so a message cannot send the journey elsewhere.
 * @param {string} raw
 * @param {string} origin such as `https://au.app.example.com`
 * @returns {URL[]}
 */
export function messageLinks(raw, origin) {
  const links = new Map();
  for (const text of textParts(raw))
    for (const [match] of text.matchAll(/https?:\/\/[^\s"'<>()]+/g)) {
      const href = match.replace(/&amp;/g, '&').replace(/[.,;]+$/, '');
      let url;
      try {
        url = new URL(href);
      } catch {
        continue;
      }
      if (url.origin === origin) links.set(url.href, url);
    }

  return [...links.values()];
}
