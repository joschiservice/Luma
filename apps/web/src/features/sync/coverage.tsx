import './sync.css';

import type { SyncOverview, SyncRecordType } from '@luma/api-contract';
import { StateDot } from '@luma/ui/components/primitives/state';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { syncOptions } from './data';
import {
  ago,
  day,
  recordTypes,
  scanProgress,
  streamState,
} from './presentation';

/** One short phrase per connection describing what Luma holds for a record type. */
export function coverageItems(overview: SyncOverview, type: SyncRecordType) {
  const now = Date.parse(overview.asOf);

  return overview.connections.flatMap((connection) => {
    const stream = connection.recordTypes.find(
      (item) => item.recordType === type,
    )?.stream;
    if (!stream) return [];
    const noun = recordTypes[type].noun;
    const state = streamState(stream);
    let text: string;
    if (stream.phase === 'backfill') {
      const progress = scanProgress(type, stream);
      text = `importing ${noun}${progress?.value != null ? ` (${Math.floor(progress.value)}%)` : ''}`;
    } else if (stream.coverage.historyFrom)
      text = `${noun} since ${day(stream.coverage.historyFrom)}`;
    else text = `all ${noun}`;
    const freshness =
      stream.error || stream.blocked || stream.paused
        ? state.label.toLowerCase()
        : stream.lastSuccessAt
          ? `synced ${ago(stream.lastSuccessAt, now)}`
          : null;

    return [
      {
        id: connection.connectionId,
        state: state.state,
        text: `${connection.label}: ${text}${freshness ? ` · ${freshness}` : ''}`,
      },
    ];
  });
}

/**
 * States which sources and creation dates a record list covers, linking to Data sync.
 * Renders nothing until a sync exists for the record type.
 */
export function SyncCoverage({
  organizationId,
  type,
}: {
  organizationId: string;
  type: SyncRecordType;
}) {
  const overview = useQuery(syncOptions(organizationId));
  const items = overview.data ? coverageItems(overview.data, type) : [];
  if (!items.length) return null;

  return (
    <p className="sync-coverage-note">
      <span className="sync-coverage-label">Coverage</span>
      {items.map((item) => (
        <span key={item.id} className="sync-coverage-item">
          <StateDot state={item.state} />
          {item.text}
        </span>
      ))}
      <Link to="/app/$organizationId/sync" params={{ organizationId }}>
        Data sync
      </Link>
    </p>
  );
}
