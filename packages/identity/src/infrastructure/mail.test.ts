import type { Resend } from 'resend';
import { describe, expect, it, vi } from 'vitest';

import { MailRateLimited } from '../application/mail.js';
import { createResendMail } from './mail.js';

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
