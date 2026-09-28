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
      aria-label="Issue summary"
      aria-busy={loading}
    >
      {(
        [
          { label: 'Needs review', value: review, state: 'approval' },
          { label: 'Open', value: open, state: 'running' },
          { label: 'Verified in 24h', value: verified, state: 'verified' },
        ] as const
      ).map(({ label, value, state }) => (
        <div className="issue-stat" key={label}>
          <StateDot state={state} className="issue-stat-icon" />
          <strong>{value === undefined ? '—' : value.toLocaleString()}</strong>
          <span>{label}</span>
        </div>
      ))}
    </section>
  );
}
