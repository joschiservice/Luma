import { QueryCache, QueryClient } from '@tanstack/react-query';

/** Call per router/request; never share a server cache between users. */
export function createQueryClient() {
  const client = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (
          query.queryKey[0] === 'private' &&
          'status' in error &&
          error.status === 401
        ) {
          void client.cancelQueries({ queryKey: ['private'] }).then(() => {
            client.removeQueries({ queryKey: ['private'] });
            client.setQueryData(['private', 'session'], null);
          });
        }
      },
    }),
    defaultOptions: { queries: { staleTime: 30_000 } },
  });
  return client;
}
