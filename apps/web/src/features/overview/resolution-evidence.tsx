import {
  measurementHistorySchema,
  type OperationalMetricResponse,
} from '@luma/api-contract';
import { Button } from '@luma/ui/components/primitives/button';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

type Item = Extract<
  OperationalMetricResponse['metrics'][number]['items'][number],
  { kind: 'resolution' }
>;

/** Loads versioned measurement facts on demand and shows retained evidence identities without claiming action acceptance proves an outcome. */
export function ResolutionEvidence({
  organizationId,
  item,
}: {
  organizationId: string;
  item: Item;
}) {
  const [open, setOpen] = useState(false);
  const [after, setAfter] = useState(0);
  const query = useQuery({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'measurement-facts',
      item.id,
      item.revision,
      after,
    ],
    ...privateQueryDefaults,
    enabled: open,
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await api.operations.measurementHistory({
        params: { organizationId, exceptionId: item.id },
        query: { after },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200)
        throw new IdentityError(result.status, result.body);

      return measurementHistorySchema.parse(result.body);
    },
  });

  return (
    <Disclosure open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Evidence & measurement facts · revision {item.revision}</summary>
      <p>
        {item.evidenceRefCount ?? item.evidenceRefs.length} retained evidence
        references. Open the issue for source observations and the execution
        history.
      </p>
      {(item.evidenceRefCount ?? 0) > item.evidenceRefs.length ? (
        <p>
          Showing the first {item.evidenceRefs.length} references. Open the
          issue to inspect all source evidence.
        </p>
      ) : null}
      <ul>
        {item.evidenceRefs.map((ref) => (
          <li key={ref}>
            <code>{ref}</code>
          </li>
        ))}
      </ul>
      {query.isError || query.isPaused ? (
        <p role="status">
          Measurement facts unavailable.{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : query.isPending ? (
        <p role="status">Loading measurement facts…</p>
      ) : (
        <>
          <ol>
            {query.data.items.map((event) => (
              <li key={event.id}>
                <strong>{event.fact.kind.replaceAll('_', ' ')}</strong> ·
                revision {event.revision} ·{' '}
                <WorkspaceDate value={event.recordedAt} />
                <p>
                  {event.fact.kind === 'eligibility'
                    ? `${event.fact.status} · ${event.fact.ruleVersion} · ${event.fact.reasonCode}`
                    : event.fact.kind === 'attribution'
                      ? `${event.fact.involvement.replaceAll('_', ' ')} · ${event.fact.complete ? 'complete' : 'partial'} attribution · ${event.fact.from} to ${event.fact.through}`
                      : event.fact.kind === 'environment'
                        ? event.fact.environment
                        : event.fact.kind === 'baseline'
                          ? `${event.fact.sampleSize} measured samples · ${event.fact.measuredSeconds} seconds · ${event.fact.processVersion}`
                          : `${event.fact.proposalId} · ${event.fact.reasonCode}`}
                </p>
                <small>
                  Fact {event.id} · recorded by {event.actorId}
                </small>
              </li>
            ))}
          </ol>
          <div className="order-cohort-pagination">
            <Button
              variant="outline"
              size="sm"
              disabled={!after || query.isFetching}
              onClick={() => setAfter(Math.max(0, after - 100))}
            >
              Previous facts
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={query.data.nextRevision === null || query.isFetching}
              onClick={() => {
                if (query.data.nextRevision !== null)
                  setAfter(query.data.nextRevision);
              }}
            >
              More facts
            </Button>
          </div>
          {!query.data.items.length ? (
            <p>
              No measurement assessments retained. Attribution remains unknown.
            </p>
          ) : null}
        </>
      )}
    </Disclosure>
  );
}
