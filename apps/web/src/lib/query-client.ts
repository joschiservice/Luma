import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

const unauthenticated = (error: Error) =>
  'status' in error && Number(error.status) === 401;

/** Call per router/request; never share a server cache between users. */
export function createQueryClient() {
  // Drops private data and empties the session so mounted guards redirect to sign-in.
  const endSession = () =>
    void client.cancelQueries({ queryKey: ['private'] }).then(() => {
      // Keep the observed session query so mounted guards receive session loss.
      client.removeQueries({
        queryKey: ['private'],
        predicate: (entry) => entry.queryKey[1] !== 'session',
      });
      client.setQueryData(['private', 'session'], null);
    });
  const client = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (
          query.queryKey[0] === 'private' &&
          query.queryKey[3] === 'activity' &&
          'status' in error &&
          [403, 404].includes(Number(error.status))
        ) {
          const prefix = query.queryKey.slice(0, 4);
          void client
            .cancelQueries({ queryKey: prefix })
            .then(() => client.removeQueries({ queryKey: prefix }));
        }

        if (query.queryKey[0] === 'private' && unauthenticated(error))
          endSession();
      },
    }),
    // A write rejected for an ended session leads to sign-in, as a failed read does.
    mutationCache: new MutationCache({
      onError: (error) => {
        if (unauthenticated(error)) endSession();
      },
    }),
    defaultOptions: { queries: { staleTime: 30_000 } },
  });

  return client;
}
