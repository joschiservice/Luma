import { describe, expect, it } from 'vitest';

import { IdentityError } from './data';
import { requestErrorMessage } from './errors';

describe('requestErrorMessage', () => {
  it('explains generic failures with a next step', () => {
    expect(requestErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'Luma couldn’t reach the server. Check your connection and try again.',
    );
    expect(requestErrorMessage(new IdentityError(401))).toBe(
      'Your session has ended. Sign in again to continue.',
    );
    expect(requestErrorMessage({ status: 403 })).toBe(
      'You don’t have access to this. Ask a workspace admin if you need it.',
    );
    expect(requestErrorMessage(new IdentityError(429))).toBe(
      'Too many requests. Wait a moment and try again.',
    );
    expect(
      requestErrorMessage(
        new IdentityError(503, {
          code: 'NOT_READY',
          message: 'Database warming up',
          requestId: 'r',
        }),
      ),
    ).toBe('Luma couldn’t complete this request. Try again in a moment.');
  });

  it('keeps server messages for specific failures and falls back otherwise', () => {
    expect(
      requestErrorMessage(
        new IdentityError(409, {
          code: 'CONFLICT',
          message: 'That workflow was published elsewhere.',
          requestId: 'r',
        }),
      ),
    ).toBe('That workflow was published elsewhere.');
    expect(requestErrorMessage(new IdentityError(400), 'Check the name.')).toBe(
      'Check the name.',
    );
  });
});
