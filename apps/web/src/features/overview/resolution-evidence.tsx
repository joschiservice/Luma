import {
  type MeasurementCommand,
  measurementHistorySchema,
  type OperationalMetricResponse,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Button } from '@luma/ui/components/primitives/button';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

type MeasurementFact = MeasurementCommand['fact'];

const kindLabels = {
  eligibility: m.overview_evidence_kind_eligibility,
  attribution: m.overview_evidence_kind_attribution,
  environment: m.overview_evidence_kind_environment,
  baseline: m.overview_evidence_kind_baseline,
  incorrect_action: m.overview_evidence_kind_incorrect_action,
} satisfies Record<MeasurementFact['kind'], () => string>;

const eligibilityLabels = {
  eligible: m.overview_eligibility_eligible,
  ineligible: m.overview_eligibility_ineligible,
  unknown: m.overview_eligibility_unknown,
} satisfies Record<
  Extract<MeasurementFact, { kind: 'eligibility' }>['status'],
  () => string
>;

const helpLabels = {
  none: m.overview_involvement_none,
  approval: m.overview_evidence_help_approval,
  manual_repair: m.overview_evidence_help_manual_repair,
  operator_correction: m.overview_evidence_help_operator_correction,
  unknown: m.overview_involvement_unknown,
} satisfies Record<
  Extract<MeasurementFact, { kind: 'attribution' }>['involvement'],
  () => string
>;

const environmentLabels = {
  live: m.overview_outcomes_env_live,
  pilot: m.overview_outcomes_env_pilot,
  synthetic: m.overview_outcomes_env_synthetic,
  shadow: m.overview_outcomes_env_shadow,
  unknown: m.overview_outcomes_env_unknown,
} satisfies Record<
  Extract<MeasurementFact, { kind: 'environment' }>['environment'],
  () => string
>;

type Item = Extract<
  OperationalMetricResponse['metrics'][number]['items'][number],
  { kind: 'resolution' }
>;

/**
 * Loads an issue's measurement history on demand and lists its retained evidence references,
 * without treating an accepted action as proof of an outcome.
 */
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

  const evidenceCount = item.evidenceRefCount ?? item.evidenceRefs.length;

  return (
    <Disclosure open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{m.overview_evidence_summary()}</summary>
      <p>{m.overview_evidence_count({ count: evidenceCount })}</p>
      {evidenceCount > item.evidenceRefs.length ? (
        <p>
          {m.overview_evidence_truncated({ count: item.evidenceRefs.length })}
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
          {m.overview_evidence_error()}{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void query.refetch()}
          >
            {m.common_retry()}
          </Button>
        </p>
      ) : query.isPending ? (
        <p role="status">{m.overview_evidence_loading()}</p>
      ) : (
        <>
          <ol>
            {query.data.items.map((event) => (
              <li key={event.id}>
                <strong>{kindLabels[event.fact.kind]()}</strong> ·{' '}
                <WorkspaceDate value={event.recordedAt} />
                <p>
                  <FactDetail fact={event.fact} />
                </p>
                <small>
                  {m.overview_evidence_entry({
                    id: event.id,
                    actor: event.actorId,
                  })}
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
              {m.overview_evidence_previous()}
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
              {m.overview_evidence_more()}
            </Button>
          </div>
          {!query.data.items.length ? (
            <p>{m.overview_evidence_empty()}</p>
          ) : null}
        </>
      )}
    </Disclosure>
  );
}

// Rule versions, reason codes, process versions and proposal IDs are recorded identifiers and
// stay as stored.
function FactDetail({ fact }: { fact: MeasurementFact }) {
  switch (fact.kind) {
    case 'eligibility':
      return `${eligibilityLabels[fact.status]()} · ${fact.ruleVersion} · ${fact.reasonCode}`;
    case 'attribution':
      return rich(
        fact.complete
          ? m.overview_evidence_period_complete
          : m.overview_evidence_period_partial,
        {
          involvement: helpLabels[fact.involvement](),
          from: <WorkspaceDate value={fact.from} />,
          through: <WorkspaceDate value={fact.through} />,
        },
      );
    case 'environment':
      return environmentLabels[fact.environment]();
    case 'baseline':
      return m.overview_evidence_baseline({
        count: fact.sampleSize,
        duration: formatNumber(fact.measuredSeconds, {
          style: 'unit',
          unit: 'second',
          unitDisplay: 'long',
        }),
        process: fact.processVersion,
      });
    case 'incorrect_action':
      return `${fact.proposalId} · ${fact.reasonCode}`;
  }
}
