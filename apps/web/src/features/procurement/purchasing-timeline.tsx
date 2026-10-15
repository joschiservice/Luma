import type { PurchaseOrderRecord } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Card } from '@luma/ui/components/primitives/card';
import {
  type OperationalState,
  StatePill,
} from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { actorLabel } from '@luma/ui/lib/actor';

import { commitmentKinds, statusLabels } from './presentation';

const kinds = {
  draft: m.procurement_timeline_draft,
  lifecycle: m.procurement_timeline_lifecycle,
  submission: m.procurement_timeline_submission,
  supplier_message: m.procurement_timeline_message,
  commitment: m.procurement_timeline_commitment,
  follow_up: m.procurement_timeline_follow_up,
  revision: m.procurement_timeline_revision,
  stock_booking: m.procurement_timeline_stock,
};
const stages = {
  recorded: { label: m.procurement_timeline_recorded, state: 'idle' },
  approval_required: {
    label: m.procurement_timeline_approval,
    state: 'approval',
  },
  approved: { label: m.procurement_timeline_approved, state: 'idle' },
  rejected: { label: m.procurement_timeline_rejected, state: 'idle' },
  sending: { label: m.procurement_timeline_sending, state: 'running' },
  sent: { label: m.procurement_timeline_sent, state: 'waiting' },
  observed: { label: m.procurement_timeline_observed, state: 'idle' },
  uncertain: { label: m.procurement_timeline_uncertain, state: 'attention' },
  failed: { label: m.procurement_timeline_failed, state: 'error' },
  verified: { label: m.procurement_timeline_verified, state: 'verified' },
} satisfies Record<
  PurchaseOrderRecord['timeline']['entries'][number]['stage'],
  { label: () => string; state: OperationalState }
>;
const sources = {
  luma: m.procurement_timeline_luma,
  manual: m.procurement_timeline_manual,
  purchasing_system: m.procurement_timeline_purchasing_system,
  email: m.procurement_timeline_email,
  inventory: m.procurement_timeline_inventory,
};

/** Presents recorded decisions, provider observations and independent verification together without conflating them. */
export function PurchasingTimeline({
  record,
}: {
  record: PurchaseOrderRecord;
}) {
  return (
    <Card
      as="section"
      className="procurement-section"
      aria-labelledby="purchasing-timeline-title"
    >
      <div className="procurement-section-heading">
        <h2 id="purchasing-timeline-title">{m.procurement_timeline_title()}</h2>
      </div>
      <p className="procurement-note">{m.procurement_timeline_note()}</p>
      {!record.timeline.complete ? (
        <p role="status" className="procurement-note">
          {m.procurement_timeline_truncated()}
        </p>
      ) : null}
      <ol className="procurement-commitments">
        {record.timeline.entries.map((entry) => {
          const stage = stages[entry.stage];
          const transition =
            entry.kind === 'lifecycle' ? entry.detail?.split('->') : undefined;
          const from = Object.entries(statusLabels).find(
            ([key]) => key === transition?.[0],
          )?.[1]();
          const to = Object.entries(statusLabels).find(
            ([key]) => key === transition?.[1],
          )?.[1]();
          const label =
            entry.kind === 'commitment'
              ? Object.entries(commitmentKinds).find(
                  ([key]) => key === entry.detail,
                )?.[1]()
              : entry.kind === 'lifecycle'
                ? from && to
                  ? `${from} → ${to}`
                  : Object.entries(statusLabels).find(
                      ([key]) => key === entry.detail,
                    )?.[1]()
                : undefined;

          return (
            <li key={entry.id}>
              <span className="procurement-cell">
                <strong>{label ?? kinds[entry.kind]()}</strong>
                <small>
                  <WorkspaceDate value={entry.at} /> · {sources[entry.source]()}
                  {entry.revision !== null
                    ? ` · ${m.procurement_changes_revision({ revision: formatNumber(entry.revision) })}`
                    : ''}
                </small>
                <StatePill state={stage.state}>{stage.label()}</StatePill>
                {entry.quantity !== null ? (
                  <span>
                    {formatNumber(entry.quantity)}
                    {entry.unit ? ` ${entry.unit}` : ''}
                  </span>
                ) : null}
                {entry.reason ? <p>{entry.reason}</p> : null}
                {entry.actorId ? (
                  <small>
                    {m.procurement_timeline_actor({
                      actor: entry.actor
                        ? actorLabel(entry.actor)
                        : m.common_actor_not_recorded(),
                    })}
                  </small>
                ) : null}
                {entry.evidenceRefs.length ? (
                  <details>
                    <summary>
                      {m.procurement_timeline_evidence({
                        count: formatNumber(entry.evidenceRefs.length),
                      })}
                    </summary>
                    <ul>
                      {entry.evidenceRefs.map((ref, index) => (
                        <li key={`${index}:${ref}`}>
                          <code>{ref}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
