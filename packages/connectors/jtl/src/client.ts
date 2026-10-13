import { ConnectorError } from '@luma/connector-core';
import {
  fail,
  type ReadRetry,
  retryAfterMs,
  retryRead,
} from '@luma/connector-core/transport';
import { z } from 'zod';

export const API_VERSION = '2.2';

type JtlConnection =
  | { kind: 'cloud'; jtlTenantId: string; accessToken(): Promise<string> }
  | {
      kind: 'onprem';
      /** Trusted API root, including the database path and trailing slash. */
      baseUrl: string;
      appId: string;
      appVersion: string;
      challengeCode: string;
      apiKey(): Promise<string>;
    };

export interface JtlTransportOptions {
  connection: JtlConnection;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Repetition of reads after transient failures; defaults to three attempts. */
  readRetry?: ReadRetry;
}

const header = z
  .string()
  .min(1)
  .regex(/^[\x20-\x7e]+$/);

/**
 * Creates an authenticated JTL transport with bounded requests. Uncertain write failures
 * require reconciliation rather than an automatic retry.
 */
export function createClient(options: JtlTransportOptions) {
  const connection = { ...options.connection };
  let base: URL;
  try {
    base = new URL(
      connection.kind === 'cloud'
        ? 'https://api.jtl-cloud.com/erp/v2/'
        : connection.baseUrl,
    );
  } catch {
    fail('invalid_input');
  }
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !base.pathname.endsWith('/') ||
    (base.protocol !== 'https:' &&
      !(
        base.protocol === 'http:' &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
      ))
  )
    fail('invalid_input');
  if (connection.kind === 'cloud') {
    if (!z.string().uuid().safeParse(connection.jtlTenantId).success)
      fail('invalid_input');
  } else if (
    ![connection.appId, connection.appVersion, connection.challengeCode].every(
      (value) => header.safeParse(value).success,
    ) ||
    connection.challengeCode.length > 30
  )
    fail('invalid_input');
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail('invalid_input');
  const { readRetry } = options;

  async function send(
    path: string,
    query: Record<string, string> = {},
    write?: {
      /** Defaults to PATCH. */
      method?: 'PATCH' | 'POST' | 'DELETE';
      body: unknown;
      idempotencyKey: string;
      receipt?(requestId: string | null): void;
    },
  ): Promise<unknown> {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    let credential: string;
    try {
      credential = await (connection.kind === 'cloud'
        ? connection.accessToken()
        : connection.apiKey());
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      fail('transient', 1000);
    }
    if (!header.safeParse(credential).success || !credential.trim())
      fail('authentication');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (connection.kind === 'cloud') {
      headers.Authorization = `Bearer ${credential}`;
      headers['X-Tenant-ID'] = connection.jtlTenantId;
    } else {
      headers.Authorization = `Wawi ${credential}`;
      headers['api-version'] = API_VERSION;
      headers['x-appid'] = connection.appId;
      headers['x-appversion'] = connection.appVersion;
      headers['x-challengecode'] = connection.challengeCode;
    }
    if (write) {
      headers['Content-Type'] = 'application/json';
      headers['Idempotency-Key'] = write.idempotencyKey;
    }
    const signal = AbortSignal.timeout(timeoutMs);
    let providerRequestId: string | null = null;
    try {
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: write ? (write.method ?? 'PATCH') : 'GET',
        ...(write ? { body: JSON.stringify(write.body) } : {}),
        headers,
        redirect: 'error',
        signal,
      });
      const requestId = response.headers.get('x-request-id');
      providerRequestId =
        requestId && /^[\x21-\x7e]{1,200}$/.test(requestId) ? requestId : null;
      if (response.status === 401) fail('authentication');
      if ([402, 403].includes(response.status)) fail('permission_denied');
      if (response.status === 404) fail('not_found');
      if ([409, 412].includes(response.status)) fail('conflict');
      if (write && response.status === 400) fail('invalid_input');
      if (response.status === 429 || response.status === 503) {
        fail(
          response.status === 429 ? 'rate_limited' : 'transient',
          retryAfterMs(response.headers.get('retry-after')),
        );
      }
      if (response.status >= 500) fail('transient', 1000);
      if (!response.ok) fail('invalid_response');
      write?.receipt?.(providerRequestId);
      try {
        // Node's JSON source context preserves decimal tokens before IEEE-754 rounding.
        return JSON.parse(
          await response.text(),
          (_key, value: unknown, context?: { source: string }) => {
            if (
              typeof value === 'number' &&
              context &&
              /[.eE]/.test(context.source)
            )
              return context.source;

            return value;
          },
        ) as unknown;
      } catch {
        if (signal.aborted) fail('timeout', 1000);
        fail('invalid_response');
      }
    } catch (error) {
      if (write) {
        const code =
          error instanceof ConnectorError
            ? error.failure.code
            : signal.aborted ||
                (error instanceof Error &&
                  ['AbortError', 'TimeoutError'].includes(error.name))
              ? 'timeout'
              : 'transient';
        // A failed response does not establish that the provider rolled back its write.
        if (
          !(error instanceof ConnectorError) ||
          ![
            'authentication',
            'permission_denied',
            'not_found',
            'conflict',
            'invalid_input',
          ].includes(code)
        )
          throw new ConnectorError({
            code,
            ...(providerRequestId ? { providerRequestId } : {}),
            effect: 'unknown',
            retry: 'reconcile',
          });
      }
      if (error instanceof ConnectorError) {
        if (write && providerRequestId)
          throw new ConnectorError({ ...error.failure, providerRequestId });
        throw error;
      }
      if (
        signal.aborted ||
        (error instanceof Error &&
          ['AbortError', 'TimeoutError'].includes(error.name))
      )
        fail('timeout', 1000);
      fail('transient', 1000);
    }
  }

  return {
    binding: [
      base.href,
      connection.kind,
      connection.kind === 'cloud' ? connection.jtlTenantId : connection.appId,
    ],
    /**
     * Sends one request. Reads are repeated briefly after transient failures; writes never
     * are, because a failed response does not establish that the provider rolled back.
     */
    request(
      path: string,
      query: Record<string, string> = {},
      write?: Parameters<typeof send>[2],
    ): Promise<unknown> {
      return write
        ? send(path, query, write)
        : retryRead(() => send(path, query), readRetry);
    },
  };
}
