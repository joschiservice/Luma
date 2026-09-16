import { QueryClient } from '@tanstack/react-query';

/** Call per router/request; never share a server cache between users. */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  });
}
