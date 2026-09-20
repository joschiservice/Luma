/** Private reads are immediately stale, discarded when unused, and never retried automatically. */
export const privateQueryDefaults = {
  staleTime: 0,
  gcTime: 0,
  retry: false,
} as const;
