import { Resend } from 'resend';

import {
  MailOutcomeUncertain,
  type MailProvider,
  MailRateLimited,
} from '../application/mail.js';

/**
 * Sends HTML and plain-text email through the Resend SDK. The message ID is the idempotency
 * key, so a retry within Resend's 24-hour window never sends twice. Calls time out after eight
 * seconds. A rate-limited request throws `MailRateLimited` with the provider's retry delay;
 * every other refusal or network failure throws without the message contents.
 */
export function createResendMail(
  settings: { apiKey: string; from: string },
  client: { emails: Pick<Resend['emails'], 'send'> } = new Resend(
    settings.apiKey,
  ),
): MailProvider {
  return {
    async send(message) {
      const { data, error, headers } = await client.emails.send(
        {
          from: settings.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          tags: [{ name: 'category', value: message.category }],
        },
        {
          idempotencyKey: message.id,
          signal: AbortSignal.timeout(8000),
        },
      );
      if (error) {
        if (error.name === 'rate_limit_exceeded' || error.statusCode === 429)
          throw new MailRateLimited(retryAfter(headers?.['retry-after']));
        throw new Error(`Email provider refused the message: ${error.name}`);
      }
      if (!data?.id) throw new Error('Email provider returned no receipt');

      return { providerId: data.id };
    },
  };
}

/** SES v2 errors that refuse a request because of a sending rate or quota. */
const sesThrottles = new Set([
  'TooManyRequestsException',
  'LimitExceededException',
  'Throttling',
  'ThrottlingException',
]);

/** Network failures before a connection exists, so the request never reached SES. */
const unsentNetworkErrors = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Signs an AWS request with Signature Version 4 and returns the headers to send; the composition
 * root injects the platform signer.
 */
export type AwsRequestSigner = (request: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  service: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  date: Date;
}) => Record<string, string>;

/**
 * Sends HTML and plain-text email through the Amazon SES v2 `SendEmail` API in `region`, signed
 * with Signature Version 4. Calls time out after eight seconds. With `configurationSet`, SES
 * applies that set's suppression and event settings. A throttled request or exceeded quota
 * throws `MailRateLimited`; another refusal, such as an unverified sender, throws without the
 * message contents.
 *
 * SES has no idempotency key. A timeout, a dropped connection or a server error after the
 * request was sent throws `MailOutcomeUncertain`, because SES may have accepted the message.
 * Recipients on the SES suppression list are accepted and then dropped by SES, so they resolve
 * like any other accepted message.
 */
export function createSesMail(
  settings: {
    region: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
    from: string;
    configurationSet?: string;
  },
  dependencies: {
    sign: AwsRequestSigner;
    fetch?: typeof fetch;
    now?: () => Date;
  },
): MailProvider {
  const transport = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const url = new URL(
    `https://email.${settings.region}.amazonaws.com/v2/email/outbound-emails`,
  );

  return {
    async send(message) {
      const body = JSON.stringify({
        FromEmailAddress: settings.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: message.html, Charset: 'UTF-8' },
              Text: { Data: message.text, Charset: 'UTF-8' },
            },
          },
        },
        EmailTags: [{ Name: 'category', Value: message.category }],
        ...(settings.configurationSet
          ? { ConfigurationSetName: settings.configurationSet }
          : {}),
      });
      let response: Response;
      try {
        response = await transport(url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          body,
          headers: dependencies.sign({
            method: 'POST',
            url,
            headers: { 'content-type': 'application/json' },
            body,
            service: 'ses',
            region: settings.region,
            credentials: settings.credentials,
            date: now(),
          }),
        });
      } catch (error) {
        // The cause carries only the network error, never the message.
        if (unsentNetworkErrors.has(networkErrorCode(error)))
          throw new Error('Email provider is unreachable', { cause: error });
        throw new MailOutcomeUncertain();
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (response.ok) throw new MailOutcomeUncertain();
        payload = undefined;
      }
      if (response.ok) {
        const id = (payload as { MessageId?: unknown } | undefined)?.MessageId;
        if (typeof id !== 'string' || !id) throw new MailOutcomeUncertain();

        return { providerId: id };
      }
      const code = sesErrorCode(response, payload);
      if (response.status === 429 || sesThrottles.has(code))
        throw new MailRateLimited(
          retryAfter(response.headers.get('retry-after') ?? undefined),
        );
      if (response.status >= 500) throw new MailOutcomeUncertain();
      throw new Error(
        `Email provider refused the message: ${code || response.status}`,
      );
    },
  };
}

/** Reads the SES error name from `x-amzn-ErrorType` or the JSON body, without its namespace. */
function sesErrorCode(response: Response, payload: unknown): string {
  const raw =
    response.headers.get('x-amzn-errortype') ??
    (payload && typeof payload === 'object'
      ? ['__type', 'code', 'Code']
          .map((key) => (payload as Record<string, unknown>)[key])
          .find((value) => typeof value === 'string')
      : undefined);
  if (typeof raw !== 'string') return '';
  const name = raw.split(':')[0]!.split('#').pop()!;

  return /^[A-Za-z]{1,64}$/.test(name) ? name : '';
}

/** The system error code of a failed fetch, such as `ECONNREFUSED`, when undici reports one. */
function networkErrorCode(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? cause.code
      : undefined;

  return typeof code === 'string' ? code : '';
}

/** Reads a `retry-after` value in seconds, bounded to between one second and one hour. */
function retryAfter(value: string | undefined) {
  const seconds = Number(value);

  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 3600) : 60;
}
