import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { subscribeToCaseProgress } from '@luma/api-contract/client';
import {
  CaseInvestigation,
  CaseLoading,
  CaseNotice,
} from '@luma/ui/components/case-investigation';
import {
  CaseTimeline,
  type LiveConnection,
} from '@luma/ui/components/case-timeline';
import { Button } from '@luma/ui/button';
import { progressOptions } from './progress-data';
import { casesKey } from './data';
import { IdentityError } from '../identity/data';

export function LiveCaseDetail({
  organizationId,
  exceptionId,
}: {
  organizationId: string;
  exceptionId: string;
}) {
  const [pages, setPages] = useState(1);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [connection, setConnection] = useState<LiveConnection>('connecting');
  const client = useQueryClient();
  const snapshot = useQuery(
    progressOptions(organizationId, exceptionId, pages),
  );
  useEffect(() => {
    let active = true;
    let generation = 0;
    const close = subscribeToCaseProgress({
      baseUrl: '/api',
      organizationId,
      exceptionId,
      onResync: () => {
        if (!active) return;
        const current = ++generation;
        setConnection((previous) =>
          previous === 'live' ? 'syncing' : previous,
        );
        void client
          .invalidateQueries(
            { queryKey: casesKey(organizationId) },
            { throwOnError: true, cancelRefetch: false },
          )
          .then(() => {
            if (active && generation === current) setConnection('live');
          })
          .catch(() => {
            if (active && generation === current) setConnection('disconnected');
          });
      },
      onError: () => {
        generation++;
        if (active) {
          setConnection('disconnected');
          // A closed stream can mean revoked access. Recheck reads to clear protected content.
          void client.invalidateQueries(
            { queryKey: casesKey(organizationId) },
            { cancelRefetch: false },
          );
        }
      },
    });
    return () => {
      active = false;
      generation++;
      close();
    };
  }, [client, organizationId, exceptionId, streamAttempt]);
  const refresh = () => {
    setConnection('connecting');
    setStreamAttempt((attempt) => attempt + 1);
    void snapshot.refetch();
  };
  const denied =
    snapshot.error instanceof IdentityError &&
    [401, 403, 404].includes(snapshot.error.status);
  if (denied)
    return (
      <CaseNotice error title="Case unavailable">
        This case is missing or you no longer have access.
      </CaseNotice>
    );
  const data = snapshot.data;
  if (!data)
    return snapshot.isPending ? (
      <CaseLoading />
    ) : (
      <CaseNotice error title="Progress could not be confirmed">
        Refresh to read the latest case state.
        <Button variant="outline" onClick={refresh}>
          Refresh progress
        </Button>
      </CaseNotice>
    );
  const unconfirmed =
    snapshot.isError ||
    connection === 'disconnected' ||
    connection === 'connecting';
  return (
    <CaseInvestigation
      item={data.detail}
      unconfirmed={unconfirmed}
      progress={
        <CaseTimeline
          {...data}
          connection={snapshot.isError ? 'disconnected' : connection}
          onRefresh={refresh}
        >
          {data.hasMore ? (
            <Button
              variant="outline"
              disabled={snapshot.isFetching}
              onClick={() => setPages((count) => count + 1)}
            >
              Load more history and evidence
            </Button>
          ) : null}
        </CaseTimeline>
      }
    />
  );
}
