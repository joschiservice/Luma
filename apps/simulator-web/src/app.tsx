import { QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { createSimulatorApi, saveToken } from './api';
import { Workspace } from './features/runs/workspace';
import { type ApiConnection, ApiContext, createQueryClient } from './queries';

/** The simulator control panel: one query cache and API connection per browser tab. */
export function App({ initialToken }: { initialToken: string }) {
  const [client] = useState(createQueryClient);
  const [token, setToken] = useState(initialToken);
  const connection = useMemo<ApiConnection>(
    () => ({
      api: createSimulatorApi(token),
      token,
      changeToken: (next) => {
        saveToken(next);
        client.clear();
        setToken(next);
      },
    }),
    [client, token],
  );

  return (
    <QueryClientProvider client={client}>
      <ApiContext value={connection}>
        <Workspace />
      </ApiContext>
    </QueryClientProvider>
  );
}
