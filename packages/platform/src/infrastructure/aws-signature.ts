import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Required for temporary credentials issued by AWS STS. */
  readonly sessionToken?: string;
}

/**
 * Signs a request with AWS Signature Version 4 and returns the headers to send with it.
 * Host is signed from the URL but not returned, because fetch derives the same value from
 * the URL. Other caller headers are signed and returned in lowercase. The body must be the
 * exact string that is sent.
 */
export function signAwsRequest(request: {
  readonly method: string;
  readonly url: URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly service: string;
  readonly region: string;
  readonly credentials: AwsCredentials;
  readonly date: Date;
  /** Also sends and signs `x-amz-content-sha256`, as the AWS SDKs do. */
  readonly signPayloadHash?: boolean;
}): Record<string, string> {
  const timestamp = request.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  const payloadHash = sha256Hex(request.body ?? '');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {}))
    headers[name.toLowerCase()] = value;
  if (request.signPayloadHash) headers['x-amz-content-sha256'] = payloadHash;
  headers['x-amz-date'] = timestamp;
  if (request.credentials.sessionToken)
    headers['x-amz-security-token'] = request.credentials.sessionToken;

  const signed: Record<string, string> = { ...headers, host: request.url.host };
  const names = Object.keys(signed).sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(request.url.pathname),
    canonicalQuery(request.url.searchParams),
    names
      .map((name) => `${name}:${signed[name]!.trim().replace(/\s+/g, ' ')}\n`)
      .join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  let key: Buffer = hmac(`AWS4${request.credentials.secretAccessKey}`, day);
  for (const part of [request.region, request.service, 'aws4_request'])
    key = hmac(key, part);
  const signature = hmac(key, stringToSign).toString('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** RFC 3986 unreserved characters stay literal; everything else is percent-encoded. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * AWS services other than S3 encode the already-encoded request path again, so a `%3A` in
 * a Bedrock model ID is signed as `%253A`.
 */
function canonicalPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean).map(uriEncode);
  const path = `/${segments.join('/')}`;

  return segments.length && pathname.endsWith('/') ? `${path}/` : path;
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([a, x], [b, y]) =>
      a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}
