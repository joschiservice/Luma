import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { refreshAfterChange } from './refresh';

describe('refreshAfterChange', () => {
  it('re-reads a first load that started before the change', async () => {
    const client = new QueryClient();
    let committed = false;
    let release = () => {};
    const observer = new QueryObserver(client, {
      queryKey: ['incidents'],
      queryFn: async ({ signal }) => {
        const seen = committed;
        // The first read waits until after the change, as a slow request does.
        if (!seen)
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            signal.addEventListener('abort', () => reject(signal.reason));
          });

        return seen ? ['drift'] : [];
      },
    });
    const unsubscribe = observer.subscribe(() => {});

    committed = true;
    await refreshAfterChange(client, [['incidents']]);
    release();

    await expect
      .poll(() => client.getQueryData(['incidents']))
      .toEqual(['drift']);
    unsubscribe();
  });
});
