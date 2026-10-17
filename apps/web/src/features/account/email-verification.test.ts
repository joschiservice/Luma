import { m } from '@luma/i18n/messages';
import { beforeEach, expect, it, vi } from 'vitest';

const sendVerificationEmail = vi.fn();
vi.mock('../../kit/identity/data', () => ({
  auth: { sendVerificationEmail },
}));

const { requestConfirmationLink } = await import('./email-verification');

beforeEach(() => {
  sendVerificationEmail.mockReset();
});

it('asks for an address before sending', async () => {
  expect(await requestConfirmationLink('  ')).toBe(
    m.identity_verify_enter_email(),
  );
  expect(sendVerificationEmail).not.toHaveBeenCalled();
});

it('reports a sent link without naming an account', async () => {
  sendVerificationEmail.mockResolvedValue({ data: { status: true } });

  expect(await requestConfirmationLink(' ada@example.test ')).toBe(
    m.identity_verify_resent(),
  );
  expect(sendVerificationEmail).toHaveBeenCalledWith({
    email: 'ada@example.test',
  });
});

it.each([
  [{ status: 429 }, m.identity_verify_rate_limited()],
  [
    { status: 400, code: 'VERIFICATION_EMAIL_NOT_ENABLED' },
    m.identity_verify_unavailable(),
  ],
  [{ status: 500 }, m.identity_verify_send_failed()],
])('explains a refused request %o', async (error, message) => {
  sendVerificationEmail.mockResolvedValue({ error });

  expect(await requestConfirmationLink('ada@example.test')).toBe(message);
});

it('explains a network failure', async () => {
  sendVerificationEmail.mockRejectedValue(new TypeError('offline'));

  expect(await requestConfirmationLink('ada@example.test')).toBe(
    m.identity_verify_send_failed(),
  );
});
