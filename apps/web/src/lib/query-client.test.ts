import { describe, expect, it } from 'vitest';
import { createQueryClient } from './query-client';

describe('request-scoped Query clients', () => {
  it('does not share one request’s server data with another', () => {
    const first = createQueryClient();
    const second = createQueryClient();
    try {
      first.setQueryData(['current-user'], { name: 'Ada' });
      expect(second.getQueryData(['current-user'])).toBeUndefined();
    } finally {
      first.clear();
      second.clear();
    }
  });
});
