import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Empty } from '@luma/ui/components/primitives/empty';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { useState } from 'react';

import { appsOptions } from '../apps/data';
import { AppExtension } from '../apps/extension';
import { SyncCoverage } from '../sync/coverage';

/** Opens customer context from installed apps, keeping each source identity separate. */
export function CustomersPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/customers',
  });
  const search = useSearch({ from: '/app/$organizationId/customers' });
  const apps = useQuery(appsOptions(organizationId));
  const [selected, setSelected] = useState(search.appId ?? '');
  const available = (apps.data?.catalog ?? []).filter(
    (app) =>
      app.ui.includes('customers') &&
      apps.data?.installations.some(
        (item) => item.appId === app.id && item.status === 'installed',
      ),
  );
  const app = available.find((item) => item.id === selected) ?? available[0];

  return (
    <main className="page-wide">
      <PageTitle title="Customers" />
      <SyncCoverage organizationId={organizationId} type="customers" />
      {apps.isPending ? (
        <p role="status">Loading customer sources…</p>
      ) : apps.error ? (
        <Alert role="alert">
          Customer sources could not be loaded.{' '}
          <Button variant="outline" onClick={() => void apps.refetch()}>
            Retry
          </Button>
        </Alert>
      ) : !app ? (
        <Empty>
          <h2>Connect a customer source</h2>
          <p>
            Install and authorize an app with customer access to see its
            customers here.
          </p>
          <a href={`/app/${organizationId}/apps`}>Open apps</a>
        </Empty>
      ) : (
        <>
          {available.length > 1 ? (
            <div className="form-field">
              <label htmlFor="customer-app">Source app</label>
              <select
                id="customer-app"
                value={app.id}
                onChange={(event) => setSelected(event.target.value)}
              >
                {available.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <AppExtension
            appId={app.id}
            organizationId={organizationId}
            slot="customers"
            customer={{
              connectionId: search.connectionId,
              id: search.customerId,
            }}
            done={async () => undefined}
          />
        </>
      )}
    </main>
  );
}
