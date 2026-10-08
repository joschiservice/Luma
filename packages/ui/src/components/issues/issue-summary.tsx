import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';

import { StateDot } from '../primitives/state';

/** Summarizes issues needing review, open issues, and verified resolutions in one line. */
export function IssueSummary({
  review,
  open,
  verified,
  loading = false,
}: {
  review?: number | undefined;
  open?: number | undefined;
  verified?: number | undefined;
  loading?: boolean;
}) {
  return (
    <section
      className="issue-summary"
      aria-label={m.issues_summary_label()}
      aria-busy={loading}
    >
      {(
        [
          {
            label: m.issues_summary_needs_review(),
            value: review,
            state: 'approval',
          },
          { label: m.issues_summary_open(), value: open, state: 'running' },
          {
            label: m.issues_summary_verified(),
            value: verified,
            state: 'verified',
          },
        ] as const
      ).map(({ label, value, state }) => (
        <div className="issue-stat" key={state}>
          <StateDot state={state} className="issue-stat-icon" />
          <strong>
            {value === undefined ? m.common_empty_value() : formatNumber(value)}
          </strong>
          <span>{label}</span>
        </div>
      ))}
    </section>
  );
}
