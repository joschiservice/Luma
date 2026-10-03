import { Card } from '@luma/ui/components/primitives/card';
import type { ReactNode } from 'react';

/**
 * Shows one headline number with its label and an optional supporting line. Pass `value` as
 * null when the number is unknown; the tile then says so instead of showing zero.
 */
export function MetricTile({
  label,
  value,
  detail,
  status,
}: {
  label: string;
  value: string | null;
  detail?: ReactNode;
  /** A labeled state shown beside the value, such as a warning badge. */
  status?: ReactNode;
}) {
  return (
    <Card as="article" className="sim-tile">
      <h3 className="sim-tile-label">{label}</h3>
      <p className="sim-tile-value lu-numeric">
        {value ?? <span className="sim-muted">Not reported</span>}
      </p>
      {status}
      {detail ? <p className="sim-tile-detail">{detail}</p> : null}
    </Card>
  );
}
