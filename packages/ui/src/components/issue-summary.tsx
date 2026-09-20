import { Check, Inbox, Search } from 'lucide-react';

/** Summarizes issues needing review, open issues, and verified resolutions. */
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
      {[
        { label: 'Needs review', value: review, Icon: Inbox, tone: 'warning' },
        { label: 'Open issues', value: open, Icon: Search, tone: 'info' },
        {
          label: 'Verified · 24h',
          value: verified,
          Icon: Check,
          tone: 'success',
        },
      ].map(({ label, value, Icon, tone }) => (
        <div className="issue-stat" key={label}>
          <div>
            <span>{label}</span>
            <strong>
              {value === undefined ? '—' : value.toLocaleString()}
            </strong>
          </div>
          <Icon
            aria-hidden="true"
            strokeWidth={1.25}
            className={`issue-stat-icon status-${tone}`}
          />
        </div>
      ))}
    </section>
  );
}
