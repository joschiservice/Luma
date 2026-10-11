import { createHash } from 'node:crypto';

import {
  json,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderTarget,
  type RateLimit,
  type RecordPage,
} from '@luma/simulator-core';

import {
  attachmentIdLength,
  snippet,
  storeMessage,
  threadByReferences,
  threadMessages,
} from './messages.js';
import {
  buildMime,
  contents,
  header,
  messageIds,
  MimeError,
  parseAddresses,
  parseMime,
} from './mime.js';
import {
  type AttachmentRecord,
  bareId,
  baseSubject,
  encodeText,
  type GmailContext,
  kinds,
  mailbox,
  type MessageRecord,
  systemLabels,
  toBase64Url,
  userLabels,
  type WatchRecord,
} from './model.js';
import { compileQuery, QueryError, searchLabels } from './query.js';

const day = 86_400_000;

/** Scopes the simulated consent screen grants. */
export const grantedScopes = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
].join(' ');

const statusNames: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
};

/** Builds a Google API error body. */
export function gmailError(
  status: number,
  message: string,
  reason = status === 404
    ? 'notFound'
    : status === 400
      ? 'invalidArgument'
      : 'backendError',
): ProviderResponse {
  return json(
    {
      error: {
        code: status,
        message,
        errors: [{ message, domain: 'global', reason }],
        status: statusNames[status] ?? 'UNKNOWN',
      },
    },
    status,
  );
}

const notFound = () => gmailError(404, 'Requested entity was not found.');

/** Google's OAuth error body. */
const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

class ApiError extends Error {
  constructor(readonly response: ProviderResponse) {
    super('Gmail API error');
  }
}

const isOAuth = (url: URL) => url.hostname === 'oauth2.googleapis.com';

/** The path below `users/{userId}/`, with the user ID. */
function route(url: URL) {
  const match = /^\/(?:upload\/)?gmail\/v1\/users\/([^/]+)\/(.*?)\/?$/.exec(
    url.pathname,
  );

  return match
    ? {
        user: decodeURIComponent(match[1]!),
        path: match[2]!.split('/').map(decodeURIComponent),
      }
    : null;
}

/** Names a Gmail or OAuth request for fault targeting, metrics and the journal. */
export function identify(request: ProviderRequest): ProviderTarget {
  const url = new URL(request.url);
  const write = request.method !== 'GET' && request.method !== 'HEAD';
  if (isOAuth(url))
    return {
      operation: url.pathname.startsWith('/revoke')
        ? 'oauth.revoke'
        : 'oauth.token',
      write,
    };
  const path = route(url)?.path ?? [];
  const [root, id, sub] = path;
  let operation = 'unknown';
  if (root === 'profile') operation = 'account.read';
  else if (root === 'labels') operation = 'labels.read';
  else if (root === 'watch' || root === 'stop') operation = 'watch';
  else if (root === 'threads') operation = 'message-threads.read';
  else if (root === 'messages' && id === 'send') operation = 'messages.send';
  else if (root === 'messages' && sub === 'attachments')
    operation = 'message-attachments.read';
  else if (root === 'messages') operation = 'messages.read';

  return {
    operation,
    resource: id && id !== 'send' ? id : undefined,
    write,
  };
}

/**
 * Google's answer to rejected credentials: 401 from the Gmail API, `invalid_grant` from the
 * token endpoint, as after a revoked grant.
 */
export function unauthorized(request: ProviderRequest): ProviderResponse {
  if (isOAuth(new URL(request.url)))
    return oauthError('invalid_grant', 'Token has been expired or revoked.');

  return {
    ...gmailError(
      401,
      'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.',
      'authError',
    ),
    headers: {
      'content-type': 'application/json',
      'www-authenticate':
        'Bearer realm="https://accounts.google.com/", error="invalid_token"',
    },
  };
}

/** Renames message and payload fields, as an incompatible API change would. */
export function drift(response: ProviderResponse): ProviderResponse {
  if (
    response.status >= 300 ||
    typeof response.body !== 'object' ||
    response.body === null
  )
    return response;
  const renamed: Record<string, string> = {
    messages: 'messageItems',
    payload: 'content',
    data: 'bytes',
  };

  return {
    ...response,
    body: Object.fromEntries(
      Object.entries(response.body).map(([key, value]) => [
        renamed[key] ?? key,
        value,
      ]),
    ),
  };
}

const quota: Record<string, number> = {
  'account.read': 1,
  'labels.read': 1,
  'messages.read': 5,
  'message-threads.read': 10,
  'message-attachments.read': 5,
  'messages.send': 100,
  watch: 100,
};

/**
 * Gmail's per-user quota of 250 units per second, charged per method: 5 for a message list or
 * read, 10 for a thread, 100 for a send. The token endpoint is not charged.
 */
export const rateLimit: RateLimit = {
  capacity: 250,
  restorePerSecond: 250,
  cost: (request) => quota[identify(request).operation] ?? 0,
  reject() {
    const response = gmailError(
      429,
      'User-rate limit exceeded.  Retry after 1s',
      'rateLimitExceeded',
    );

    return {
      ...response,
      headers: { ...response.headers, 'retry-after': '1' },
    };
  },
};

function bodyOf(request: ProviderRequest) {
  const type = header(
    Object.entries(request.headers).map(([name, value]) => ({ name, value })),
    'content-type',
  );
  if (!request.body) return {};
  if (type?.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(request.body);

      return typeof parsed === 'object' && parsed
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      throw new ApiError(gmailError(400, 'Invalid JSON payload received.'));
    }
  }

  return Object.fromEntries(new URLSearchParams(request.body));
}

/** A fake ID token with the mailbox's email claim; Luma must not rely on its signature. */
function idToken(address: string, clientId: string, now: number) {
  const part = (value: unknown) =>
    toBase64Url(Buffer.from(JSON.stringify(value)).toString('base64'));
  const issued = Math.floor(now / 1000);

  return [
    part({ alg: 'RS256', kid: 'simulated', typ: 'JWT' }),
    part({
      iss: 'https://accounts.google.com',
      aud: clientId,
      azp: clientId,
      sub: BigInt(
        `0x${createHash('sha256').update(address).digest('hex').slice(0, 15)}`,
      ).toString(),
      email: address,
      email_verified: true,
      iat: issued,
      exp: issued + 3600,
    }),
    'c2ltdWxhdGVkLXNpZ25hdHVyZQ',
  ].join('.');
}

async function oauth(
  context: GmailContext,
  request: ProviderRequest,
  url: URL,
): Promise<ProviderResponse> {
  if (request.method !== 'POST')
    return oauthError('invalid_request', 'POST required', 405);
  const body = bodyOf(request);
  const value = (name: string) => {
    const raw = body[name] ?? url.searchParams.get(name);

    return typeof raw === 'string' ? raw : '';
  };
  if (url.pathname.startsWith('/revoke'))
    return value('token')
      ? json({})
      : oauthError('invalid_request', 'Missing required parameter: token');
  if (url.pathname !== '/token')
    return oauthError('invalid_request', 'Not found', 404);
  const clientId = value('client_id');
  if (!clientId)
    return oauthError(
      'invalid_request',
      'Could not determine client ID from request.',
    );
  const grant = value('grant_type');
  const token = `ya29.simulated-${(await context.store.sequence('token')).toString(36)}`;
  const box = await mailbox(context);
  const issued = {
    access_token: token,
    expires_in: 3599,
    scope: grantedScopes,
    token_type: 'Bearer',
    id_token: idToken(box.address, clientId, context.wallTime),
  };
  if (grant === 'authorization_code') {
    if (!value('code'))
      return oauthError('invalid_request', 'Missing required parameter: code');
    if (!value('redirect_uri'))
      return oauthError(
        'invalid_request',
        'Missing required parameter: redirect_uri',
      );

    return json({
      ...issued,
      refresh_token: `1//simulated-${createHash('sha256')
        .update(`${box.address}:${value('code')}`)
        .digest('hex')
        .slice(0, 32)}`,
    });
  }
  if (grant === 'refresh_token') {
    if (!value('refresh_token'))
      return oauthError(
        'invalid_request',
        'Missing required parameter: refresh_token',
      );

    return json(issued);
  }

  return oauthError('unsupported_grant_type', `Invalid grant_type: ${grant}`);
}

function headersOf(message: MessageRecord, names?: string[]) {
  const wanted = names?.map((name) => name.toLowerCase());

  return wanted?.length
    ? message.headers.filter((item) => wanted.includes(item.name.toLowerCase()))
    : message.headers;
}

const textPart = (partId: string, mimeType: string, text: string) => {
  const bytes = Buffer.byteLength(text, 'utf8');

  return {
    partId,
    mimeType,
    filename: '',
    headers: [
      { name: 'Content-Type', value: `${mimeType}; charset="UTF-8"` },
      { name: 'Content-Transfer-Encoding', value: 'quoted-printable' },
    ],
    body: { size: bytes, data: encodeText(text) },
  };
};

/**
 * Builds Gmail's `payload` part tree: text, optional HTML alternative and attachments. Like
 * Gmail, attachment IDs differ between reads; any of them fetches the attachment.
 */
function payloadOf(message: MessageRecord, read: number) {
  const prefix = message.attachments.length ? '0' : '';
  const child = (index: number) =>
    prefix ? `${prefix}.${index}` : String(index);
  const body =
    message.html === null
      ? textPart(prefix, 'text/plain', message.text)
      : {
          partId: prefix,
          mimeType: 'multipart/alternative',
          filename: '',
          headers: [
            {
              name: 'Content-Type',
              value: `multipart/alternative; boundary="alt-${message.id}"`,
            },
          ],
          body: { size: 0 },
          parts: [
            textPart(child(0), 'text/plain', message.text),
            textPart(child(1), 'text/html', message.html),
          ],
        };
  const top = message.attachments.length
    ? {
        partId: '',
        mimeType: 'multipart/mixed',
        filename: '',
        headers: [
          {
            name: 'Content-Type',
            value: `multipart/mixed; boundary="mixed-${message.id}"`,
          },
        ],
        body: { size: 0 },
        parts: [
          body,
          ...message.attachments.map((attachment, index) => ({
            partId: String(index + 1),
            mimeType: attachment.mimeType,
            filename: attachment.filename,
            headers: [
              {
                name: 'Content-Type',
                value: `${attachment.mimeType}; name="${attachment.filename}"`,
              },
              {
                name: 'Content-Disposition',
                value: `attachment; filename="${attachment.filename}"`,
              },
              { name: 'Content-Transfer-Encoding', value: 'base64' },
              { name: 'X-Attachment-Id', value: `f_${message.id}_${index}` },
            ],
            body: {
              // Gmail attachment IDs are base64url, so the per-read suffix has no separator.
              attachmentId: `${attachment.attachmentId}${read.toString(36)}`,
              size: attachment.size,
            },
          })),
        ],
      }
    : body;
  const own = new Set(top.headers.map((item) => item.name.toLowerCase()));

  return {
    ...top,
    headers: [
      ...message.headers.filter((item) => !own.has(item.name.toLowerCase())),
      ...top.headers,
    ],
  };
}

const sizeEstimate = (message: MessageRecord) =>
  message.headers.reduce(
    (sum, item) => sum + item.name.length + item.value.length + 4,
    0,
  ) +
  Buffer.byteLength(message.text) +
  Buffer.byteLength(message.html ?? '') +
  message.attachments.reduce(
    (sum, item) => sum + Math.ceil(item.size * 1.37),
    0,
  );

async function messageJson(
  context: GmailContext,
  message: MessageRecord,
  format: string,
  metadataHeaders: string[],
) {
  const base = {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds,
    snippet: snippet(message.text),
    sizeEstimate: sizeEstimate(message),
    historyId: String(message.historyId),
    internalDate: String(message.internalDate),
  };
  if (format === 'minimal') return base;
  if (format === 'metadata')
    return {
      ...base,
      payload: {
        partId: '',
        mimeType: message.attachments.length
          ? 'multipart/mixed'
          : message.html === null
            ? 'text/plain'
            : 'multipart/alternative',
        filename: '',
        headers: headersOf(message, metadataHeaders),
        body: { size: 0 },
      },
    };
  if (format === 'raw') {
    const attachments = await context.store.page<AttachmentRecord>({
      kind: kinds.attachment,
      parent: message.id,
      limit: 100,
    });
    const raw = buildMime({
      headers: message.headers.filter(
        (item) =>
          ![
            'content-type',
            'mime-version',
            'content-transfer-encoding',
          ].includes(item.name.toLowerCase()),
      ),
      text: message.text,
      html: message.html,
      attachments: message.attachments.map((meta) => ({
        filename: meta.filename,
        mimeType: meta.mimeType,
        base64:
          attachments.items.find((item) => item.id === meta.attachmentId)?.data
            .base64 ?? '',
      })),
      boundary: `sim-${message.id}`,
    });

    return { ...base, raw: toBase64Url(Buffer.from(raw).toString('base64')) };
  }

  return { ...base, payload: payloadOf(message, context.wallTime) };
}

function format(url: URL) {
  const value = url.searchParams.get('format') ?? 'full';
  if (!['full', 'metadata', 'minimal', 'raw'].includes(value))
    throw new ApiError(gmailError(400, `Invalid format: ${value}`));

  return value;
}

/** Label names by ID, for `label:` searches. */
async function labelNames(context: GmailContext) {
  return new Map(
    (await userLabels(context)).map((label) => [label.id, label.name]),
  );
}

async function listMessages(context: GmailContext, url: URL) {
  const rawLimit = url.searchParams.get('maxResults');
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new ApiError(gmailError(400, 'Invalid maxResults'));
  let query;
  try {
    query = compileQuery(url.searchParams.get('q') ?? '');
  } catch (error) {
    if (error instanceof QueryError)
      throw new ApiError(gmailError(400, 'Invalid query', 'invalidArgument'));
    throw error;
  }
  const required = url.searchParams.getAll('labelIds');
  const includeSpamTrash = url.searchParams.get('includeSpamTrash') === 'true';
  const token = url.searchParams.get('pageToken');
  const position = token ? /^(\d{1,15})-([0-9a-f]{1,32})$/.exec(token) : null;
  if (token && !position)
    throw new ApiError(gmailError(400, 'Invalid pageToken'));
  const names = await labelNames(context);
  // Search lags behind recent changes like Gmail's index; direct reads do not.
  const visibleBefore = context.indexLagMs
    ? context.now - context.indexLagMs
    : undefined;
  const matched: MessageRecord[] = [];
  let after: string | null = null;
  do {
    const page: RecordPage<MessageRecord> = await context.store.page({
      kind: kinds.message,
      // A Message-ID search reads one key; date bounds narrow everything else.
      ...(query.messageId === undefined ? {} : { key: query.messageId }),
      ...(query.after === undefined ? {} : { createdFrom: query.after }),
      after,
      limit: 500,
    });
    for (const item of page.items)
      if (visibleBefore === undefined || item.updatedAt <= visibleBefore)
        matched.push(item.data);
    after = page.next;
  } while (after);
  const results = matched
    .filter(
      (message) =>
        required.every((label) => message.labelIds.includes(label)) &&
        query.matches(
          { message, labels: searchLabels(message, names) },
          context.now,
          includeSpamTrash,
        ),
    )
    .sort(
      (a, b) => b.internalDate - a.internalDate || b.id.localeCompare(a.id),
    );
  const start = position
    ? results.findIndex(
        (message) =>
          message.internalDate < Number(position[1]) ||
          (message.internalDate === Number(position[1]) &&
            message.id < position[2]!),
      )
    : 0;
  const page = start < 0 ? [] : results.slice(start, start + limit);
  const last = page.at(-1);
  const more = start >= 0 && start + limit < results.length;

  return json({
    ...(page.length
      ? {
          messages: page.map((message) => ({
            id: message.id,
            threadId: message.threadId,
          })),
        }
      : {}),
    ...(more && last
      ? { nextPageToken: `${last.internalDate}-${last.id}` }
      : {}),
    resultSizeEstimate: results.length,
  });
}

/**
 * Sends a raw RFC 5322 message like `users.messages.send`. The From header becomes the mailbox,
 * a missing Message-ID is generated, and the message joins `threadId` only when its references
 * and subject match that thread, as Gmail requires. Sending the same message twice sends it
 * twice; callers must guard against duplicates themselves.
 */
async function send(context: GmailContext, request: ProviderRequest, url: URL) {
  let raw: string;
  let threadParam: string | null = null;
  if (url.pathname.startsWith('/upload/')) {
    if (url.searchParams.get('uploadType') !== 'media')
      throw new ApiError(gmailError(400, 'Only uploadType=media is simulated'));
    raw = request.body ?? '';
  } else {
    const body = bodyOf(request);
    if (typeof body.raw !== 'string' || !body.raw)
      throw new ApiError(
        gmailError(
          400,
          "'raw' RFC822 payload message string or uploading message via /upload/* URL required",
          'invalidArgument',
        ),
      );
    raw = Buffer.from(body.raw, 'base64url').toString('utf8');
    threadParam = typeof body.threadId === 'string' ? body.threadId : null;
  }
  let part;
  try {
    part = parseMime(raw);
  } catch (error) {
    if (error instanceof MimeError)
      throw new ApiError(gmailError(400, 'Invalid RFC822 message'));
    throw error;
  }
  const to = parseAddresses(header(part.headers, 'to'));
  const cc = parseAddresses(header(part.headers, 'cc'));
  const bcc = parseAddresses(header(part.headers, 'bcc'));
  if (!to.length && !cc.length && !bcc.length)
    throw new ApiError(
      gmailError(400, 'Recipient address required', 'invalidArgument'),
    );
  const box = await mailbox(context);
  const from = { address: box.address, name: box.name };
  const subject = header(part.headers, 'subject') ?? '';
  const inReplyTo = messageIds(header(part.headers, 'in-reply-to'))[0] ?? null;
  const references = messageIds(header(part.headers, 'references'));
  const chain = [
    ...references,
    ...(inReplyTo && !references.includes(inReplyTo) ? [inReplyTo] : []),
  ];
  let threadId: string | null = null;
  if (threadParam) {
    const thread = await threadMessages(context, threadParam);
    if (!thread.length) throw new ApiError(notFound());
    const ids = new Set(
      thread.map((message) => message.messageId.toLowerCase()),
    );
    if (
      chain.some((id) => ids.has(id.toLowerCase())) &&
      baseSubject(thread[0]!.subject) === baseSubject(subject)
    )
      threadId = threadParam;
  } else threadId = await threadByReferences(context, chain, subject);
  const id = await context.store.sequence('sent');
  const messageId = bareId(
    header(part.headers, 'message-id') ??
      `CASIM${id.toString(36)}.${context.now.toString(36)}@mail.gmail.com`,
  );
  const body = contents(part);
  const headers = part.headers
    .filter(
      (item) =>
        !['bcc', 'from', 'message-id', 'date'].includes(
          item.name.toLowerCase(),
        ),
    )
    .concat([
      {
        name: 'From',
        value: box.name ? `${box.name} <${box.address}>` : box.address,
      },
      {
        name: 'Date',
        value:
          header(part.headers, 'date') ??
          new Date(context.now).toUTCString().replace('GMT', '+0000'),
      },
      { name: 'Message-ID', value: `<${messageId}>` },
    ]);
  const message = await storeMessage(context, {
    headers,
    messageId,
    inReplyTo,
    references,
    from,
    to,
    cc,
    bcc,
    subject,
    text: body.text ?? '',
    html: body.html,
    attachments: body.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      base64: attachment.content.toString('base64'),
    })),
    labelIds: ['SENT'],
    internalDate: context.now,
    threadId,
  });

  return {
    ...json({
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds,
    }),
    committed: true,
  };
}

async function gmail(
  context: GmailContext,
  request: ProviderRequest,
  url: URL,
): Promise<ProviderResponse> {
  const authorization =
    request.headers.authorization ?? request.headers.Authorization ?? '';
  if (!/^Bearer \S+/i.test(authorization)) return unauthorized(request);
  const target = route(url);
  if (!target) return notFound();
  const box = await mailbox(context);
  if (target.user !== 'me' && target.user.toLowerCase() !== box.address)
    return gmailError(403, `Delegation denied for ${box.address}`, 'forbidden');
  const [root, id, sub, subId] = target.path;
  const get = request.method === 'GET';
  const post = request.method === 'POST';
  const metadataHeaders = url.searchParams.getAll('metadataHeaders');
  if (root === 'profile' && get && !id) {
    const [messages, threads] = await Promise.all([
      context.store.count({ kind: kinds.message }),
      context.store.count({ kind: kinds.thread }),
    ]);

    return json({
      emailAddress: box.address,
      messagesTotal: messages,
      threadsTotal: threads,
      historyId: String(await currentHistory(context)),
    });
  }
  if (root === 'labels' && get && !id) {
    const labels = await userLabels(context);

    return json({
      labels: [
        ...systemLabels.map((label) => ({
          id: label,
          name: label,
          type: 'system',
          ...(label.startsWith('CATEGORY_')
            ? {}
            : {
                messageListVisibility: 'hide',
                labelListVisibility: 'labelShow',
              }),
        })),
        ...labels.map((label) => ({
          id: label.id,
          name: label.name,
          type: 'user',
          messageListVisibility: 'show',
          labelListVisibility: 'labelShow',
        })),
      ],
    });
  }
  if (root === 'messages' && id === 'send' && post)
    return send(context, request, url);
  if (root === 'messages' && get && !id) return listMessages(context, url);
  if (root === 'messages' && get && id && !sub) {
    const record = await context.store.get<MessageRecord>(kinds.message, id);
    if (!record) return notFound();

    return json(
      await messageJson(context, record.data, format(url), metadataHeaders),
    );
  }
  if (root === 'messages' && get && id && sub === 'attachments' && subId) {
    const record = await context.store.get<AttachmentRecord>(
      kinds.attachment,
      subId.slice(0, attachmentIdLength),
    );
    if (!record || record.data.messageId !== id) return notFound();
    const bytes = Buffer.from(record.data.base64, 'base64');

    return json({
      attachmentId: record.data.attachmentId,
      size: bytes.length,
      data: toBase64Url(record.data.base64),
    });
  }
  if (root === 'threads' && get && id && !sub) {
    const shape = format(url);
    const messages = await threadMessages(context, id);
    if (!messages.length) return notFound();

    return json({
      id,
      historyId: String(
        Math.max(...messages.map((message) => message.historyId)),
      ),
      messages: await Promise.all(
        messages.map((message) =>
          messageJson(
            context,
            message,
            shape === 'raw' ? 'full' : shape,
            metadataHeaders,
          ),
        ),
      ),
    });
  }
  if (root === 'watch' && post && !id) {
    const body = bodyOf(request);
    if (
      typeof body.topicName !== 'string' ||
      !/^projects\/[^/]+\/topics\/[^/]+$/.test(body.topicName)
    )
      return gmailError(400, 'Invalid topicName', 'invalidArgument');
    const watch: WatchRecord = {
      topicName: body.topicName,
      labelIds: Array.isArray(body.labelIds)
        ? body.labelIds.filter(
            (label): label is string => typeof label === 'string',
          )
        : [],
      historyId: await currentHistory(context),
      expiration: context.wallTime + 7 * day,
    };
    await context.store.put(kinds.watch, 'me', watch, {
      createdAt: context.now,
      updatedAt: context.now,
    });

    return json({
      historyId: String(watch.historyId),
      expiration: String(watch.expiration),
    });
  }
  if (root === 'stop' && post && !id) {
    await context.store.delete(kinds.watch, 'me');

    // Gmail answers 204; the transport cannot carry an empty body, so this is an empty object.
    return json({});
  }

  return notFound();
}

/** The mailbox's latest history ID without allocating a new one. */
async function currentHistory(context: GmailContext) {
  const page = await context.store.page<MessageRecord>({
    kind: kinds.message,
    order: 'updated',
    reverse: true,
    limit: 1,
  });

  return page.items[0]?.data.historyId ?? 1000;
}

/** Serves the Gmail API subset and Google's OAuth token and revoke endpoints. */
export async function handle(
  context: GmailContext,
  request: ProviderRequest,
): Promise<ProviderResponse> {
  const url = new URL(request.url);
  try {
    if (isOAuth(url)) return await oauth(context, request, url);
    if (
      url.hostname !== 'gmail.googleapis.com' &&
      url.hostname !== 'www.googleapis.com'
    )
      return notFound();

    return await gmail(context, request, url);
  } catch (error) {
    if (error instanceof ApiError) return error.response;
    throw error;
  }
}
