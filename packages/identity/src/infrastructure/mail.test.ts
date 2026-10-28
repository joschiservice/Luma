import type { Resend } from 'resend';
import { describe, expect, it, vi } from 'vitest';

import { MailOutcomeUncertain, MailRateLimited } from '../application/mail.js';
import {
  type AwsRequestSigner,
  createResendMail,
  createSesMail,
} from './mail.js';

const message = {
  id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  to: 'mara@example.test',
  subject: 'Join Nordlicht Outdoor on Luma',
  html: '<p>Hello</p>',
  text: 'Hello',
  category: 'invitation',
};

function provider(result: Awaited<ReturnType<Resend['emails']['send']>>) {
  const send = vi.fn<Resend['emails']['send']>().mockResolvedValue(result);

  return {
    send,
    mail: createResendMail(
      { apiKey: 're_test', from: 'Luma <notifications@example.test>' },
      { emails: { send } },
    ),
  };
}

describe('createResendMail', () => {
  it('sends both parts with the message ID as idempotency key and returns the receipt', async () => {
    const { send, mail } = provider({
      data: { id: 'resend-1' },
      error: null,
      headers: null,
    });

    await expect(mail.send(message)).resolves.toEqual({
      providerId: 'resend-1',
    });
    expect(send).toHaveBeenCalledWith(
      {
        from: 'Luma <notifications@example.test>',
        to: ['mara@example.test'],
        subject: message.subject,
        html: message.html,
        text: message.text,
        tags: [{ name: 'category', value: 'invitation' }],
      },
      expect.objectContaining({ idempotencyKey: message.id }),
    );
    expect(send.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a rate limit with the provider’s delay, so the attempt is not spent', async () => {
    const { mail } = provider({
      data: null,
      error: {
        name: 'rate_limit_exceeded',
        statusCode: 429,
        message: 'Too many requests',
      },
      headers: { 'retry-after': '3' },
    });

    const error = await mail.send(message).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailRateLimited);
    expect(error).toMatchObject({ retryAfterSeconds: 3 });
  });

  it('fails without exposing message contents when the provider refuses', async () => {
    const { mail } = provider({
      data: null,
      error: {
        name: 'validation_error',
        statusCode: 422,
        message: 'Invalid `to` field: mara@example.test',
      },
      headers: null,
    });

    const error = await mail.send(message).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailRateLimited);
    expect(String(error)).not.toContain('mara@example.test');
  });
});

describe('createSesMail', () => {
  const settings = {
    region: 'ap-southeast-2',
    credentials: {
      accessKeyId: 'AKIAEXAMPLEMAIL0001',
      secretAccessKey: 'mail-secret',
    },
    from: 'Luma <notifications@example.test>',
  };

  function ses(
    respond: () => Promise<Response>,
    overrides: Partial<Parameters<typeof createSesMail>[0]> = {},
  ) {
    const fetch = vi.fn<typeof globalThis.fetch>(respond);
    const sign = vi.fn<AwsRequestSigner>(() => ({
      'content-type': 'application/json',
      authorization: 'AWS4-HMAC-SHA256 signed',
    }));

    return {
      fetch,
      sign,
      mail: createSesMail(
        { ...settings, ...overrides },
        { sign, fetch, now: () => new Date('2026-10-27T10:00:00Z') },
      ),
    };
  }

  const refusal = (status: number, type: string) =>
    new Response(JSON.stringify({ message: 'Address mara@example.test' }), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-amzn-ErrorType': `${type}:http://internal.amazon.com/coral/com.amazonaws.sesv2/`,
      },
    });

  it('posts a signed SendEmail request in the configured region and returns the message ID', async () => {
    const { fetch, sign, mail } = ses(
      async () =>
        new Response(JSON.stringify({ MessageId: 'ses-1' }), { status: 200 }),
      { configurationSet: 'luma-mail' },
    );

    await expect(mail.send(message)).resolves.toEqual({ providerId: 'ses-1' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://email.ap-southeast-2.amazonaws.com/v2/email/outbound-emails',
    );
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'AWS4-HMAC-SHA256 signed',
    });
    expect(sign).toHaveBeenCalledWith({
      method: 'POST',
      url: new URL(String(url)),
      headers: { 'content-type': 'application/json' },
      body: init?.body,
      service: 'ses',
      region: 'ap-southeast-2',
      credentials: settings.credentials,
      date: new Date('2026-10-27T10:00:00Z'),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      FromEmailAddress: 'Luma <notifications@example.test>',
      Destination: { ToAddresses: ['mara@example.test'] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: message.html, Charset: 'UTF-8' },
            Text: { Data: message.text, Charset: 'UTF-8' },
          },
        },
      },
      EmailTags: [{ Name: 'category', Value: 'invitation' }],
      ConfigurationSetName: 'luma-mail',
    });
  });

  it('omits the configuration set when none is configured', async () => {
    const { fetch, mail } = ses(
      async () =>
        new Response(JSON.stringify({ MessageId: 'ses-1' }), { status: 200 }),
    );

    await mail.send(message);
    expect(
      JSON.parse(String(fetch.mock.calls[0]![1]?.body)),
    ).not.toHaveProperty('ConfigurationSetName');
  });

  it.each([
    [429, 'TooManyRequestsException'],
    [400, 'LimitExceededException'],
  ])(
    'reports HTTP %i %s as a rate limit, so the attempt is not spent',
    async (status, type) => {
      const { mail } = ses(async () => refusal(status, type));

      const error = await mail.send(message).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MailRateLimited);
      expect(error).toMatchObject({ retryAfterSeconds: 60 });
    },
  );

  it('fails without exposing message contents when SES refuses', async () => {
    const { mail } = ses(async () => refusal(400, 'MessageRejected'));

    const error = await mail.send(message).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailRateLimited);
    expect(error).not.toBeInstanceOf(MailOutcomeUncertain);
    expect(String(error)).toContain('MessageRejected');
    expect(String(error)).not.toContain('mara@example.test');
  });

  it.each([
    [
      'a timeout',
      async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    ],
    [
      'a dropped connection',
      async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('socket hang up'), {
            code: 'ECONNRESET',
          }),
        });
      },
    ],
    ['a server error', async () => refusal(500, 'InternalFailure')],
    [
      'an accepted response without a message ID',
      async () => new Response('{}', { status: 200 }),
    ],
  ])('reports %s as uncertain', async (_, respond) => {
    const { mail } = ses(respond);

    await expect(mail.send(message)).rejects.toBeInstanceOf(
      MailOutcomeUncertain,
    );
  });

  it('reports a connection that was never made as a plain failure', async () => {
    const { mail } = ses(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), {
          code: 'ENOTFOUND',
        }),
      });
    });

    const error = await mail.send(message).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailOutcomeUncertain);
  });
});
