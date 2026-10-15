import type { OrderDetail } from '@luma/api-contract';
import { formatExactQuantity, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { actorLabel } from '@luma/ui/lib/actor';
import { Link } from '@tanstack/react-router';

/**
 * Shows source-backed milestones per part, retaining unknown occurrence times and investigation
 * candidates. Renders the content only; the order page places it in its timeline.
 */
export function OrderJourney({
  detail,
  organizationId,
  from,
}: {
  detail: OrderDetail;
  organizationId: string;
  from: string;
}) {
  const journey = detail.journey;
  const stages = {
    placed: m.orders_journey_placed(),
    paid: m.orders_journey_paid(),
    reserved: m.orders_journey_reserved(),
    picked: m.orders_journey_picked(),
    shipped: m.orders_journey_shipped(),
    delivered: m.orders_journey_delivered(),
    returned: m.orders_journey_returned(),
  };
  const provenance = {
    provider_observation: m.orders_journey_observation(),
    luma_action: m.orders_journey_action(),
    inference: m.orders_journey_inference(),
  };
  const source = (connectionId: string | null) =>
    connectionId
      ? (detail.sources.find((item) => item.connectionId === connectionId)
          ?.label ?? m.orders_source_fallback())
      : m.orders_journey_luma();

  const lineIndex = new Map(
    detail.sources
      .flatMap((source) => source.lines)
      .map((line) => [line.id, line]),
  );
  const actorIndex = new Map(
    detail.activity.entries.map((entry) => [entry.actor.id, entry.actor]),
  );
  const shipmentIndex = new Map(
    detail.fulfillments.map((item) => [
      `${item.connectionId}:${item.id}`,
      item,
    ]),
  );
  const returnIndex = new Map(
    detail.returns.map((item) => [`${item.connectionId}:${item.id}`, item]),
  );
  const timingIndex = new Map(
    (journey?.timings ?? []).map((item) => [
      `${item.connectionId}:${item.partId}:${item.orderLineId}:${item.to}`,
      item,
    ]),
  );

  return (
    <div className="order-timeline-panel">
      {!journey ? (
        <p className="order-note">{m.orders_journey_unavailable()}</p>
      ) : (
        <>
          {journey.candidates.length ? (
            <ul className="order-summary">
              {journey.candidates.map((candidate) => (
                <li
                  key={`${candidate.code}:${candidate.connectionId}:${candidate.orderLineId}`}
                  data-tone="warning"
                >
                  <span>
                    <strong>
                      {candidate.code === 'paid_without_reservation'
                        ? m.orders_journey_paid_candidate()
                        : m.orders_journey_shipped_candidate()}
                    </strong>
                    <br />
                    {m.orders_journey_candidate_owner({
                      source: source(candidate.connectionId),
                    })}
                  </span>
                  <Badge>{m.orders_journey_candidate()}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
          {journey.events.length ? (
            <ol className="order-history">
              {journey.events.map((event) => {
                const timing = timingIndex.get(
                  `${event.connectionId}:${event.partId}:${event.orderLineId}:${event.stage}`,
                );
                const shipment = shipmentIndex.get(
                  `${event.connectionId}:${event.partId}`,
                );
                const returned = returnIndex.get(
                  `${event.connectionId}:${event.partId}`,
                );
                const line = event.orderLineId
                  ? lineIndex.get(event.orderLineId)
                  : undefined;

                return (
                  <li key={event.id}>
                    <span className="orders-cell-stack">
                      <strong>
                        {stages[event.stage]} · {source(event.connectionId)}
                      </strong>
                      <small>
                        {line?.title ??
                          line?.skuCode ??
                          m.orders_journey_line()}{' '}
                        {event.quantity !== null
                          ? `· ${formatExactQuantity(event.quantity)} ${event.unit ?? ''}`
                          : ''}
                      </small>
                      <small>
                        {event.occurredAt ? (
                          <>
                            <span>{m.orders_journey_occurred()} </span>
                            <WorkspaceDate value={event.occurredAt} />
                          </>
                        ) : (
                          m.orders_journey_time_unknown()
                        )}
                      </small>
                      <small>
                        {m.orders_journey_observed()}{' '}
                        <WorkspaceDate value={event.observedAt} />
                        {event.actorId
                          ? ` · ${m.orders_journey_actor({ actor: actorIndex.has(event.actorId) ? actorLabel(actorIndex.get(event.actorId)!) : m.orders_journey_actor_unknown() })}`
                          : ''}
                      </small>
                      {timing?.durationMs !== null &&
                      timing?.durationMs !== undefined ? (
                        <small>
                          {m.orders_journey_duration({
                            from: stages[timing.from],
                            hours: formatNumber(timing.durationMs / 3600000, {
                              maximumFractionDigits: 2,
                            }),
                          })}
                        </small>
                      ) : null}
                      {shipment ? (
                        <Link
                          to="/app/$organizationId/fulfillment/$fulfillmentId"
                          params={{
                            organizationId,
                            fulfillmentId: shipment.id,
                          }}
                          search={{ from }}
                        >
                          {m.orders_journey_part({
                            part: shipment.externalId ?? shipment.id,
                          })}
                        </Link>
                      ) : null}
                      {returned ? (
                        <Link
                          to="/app/$organizationId/returns/$returnId"
                          params={{ organizationId, returnId: returned.id }}
                          search={{ from }}
                        >
                          {m.orders_journey_return_part({
                            part:
                              returned.name ??
                              returned.externalId ??
                              returned.id,
                          })}
                        </Link>
                      ) : null}
                      <details>
                        <summary>{m.orders_journey_evidence()}</summary>
                        <ul>
                          {event.references.map((ref) => (
                            <li key={`${ref.kind}:${ref.id}`}>
                              <code>
                                {ref.kind} · {ref.id}
                              </code>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </span>
                    <Badge>{provenance[event.provenance]}</Badge>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="order-note">{m.orders_journey_empty()}</p>
          )}
          {journey.truncated ? (
            <p className="order-note">
              {m.orders_journey_truncated({ count: 500 })}
            </p>
          ) : null}
          {journey.comparisons.map((comparison) =>
            comparison.count > 0 &&
            comparison.medianMs !== null &&
            comparison.p90Ms !== null ? (
              <p
                className="order-note"
                key={`${comparison.from}:${comparison.to}`}
              >
                {m.orders_journey_comparison({
                  from: stages[comparison.from],
                  to: stages[comparison.to],
                  median: formatNumber(comparison.medianMs / 3600000, {
                    maximumFractionDigits: 2,
                  }),
                  p90: formatNumber(comparison.p90Ms / 3600000, {
                    maximumFractionDigits: 2,
                  }),
                  count: comparison.count,
                })}
              </p>
            ) : null,
          )}
        </>
      )}
    </div>
  );
}
