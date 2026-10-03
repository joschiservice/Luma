import type { RunDetail, Scorecard } from '@luma/simulator-contract';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@luma/ui/components/primitives/alert';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';

import { MetricTile } from '../../components/metric-tile';
import { LoadError, Loading } from '../../components/query-state';
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatPercent,
} from '../../lib/format';
import { exceptionClassLabel } from '../../lib/labels';
import { useScorecard } from '../../queries';

type KindRow = Scorecard['byKind'][number];

type FalsePositive = Scorecard['falsePositives'][number];

type DuplicateWrite = Scorecard['duplicateWrites'][number];

/** The share of decided incidents that Luma detected; null before any is decided. */
export function detectionRate(totals: { detected: number; missed: number }) {
  const decided = totals.detected + totals.missed;

  return decided > 0 ? totals.detected / decided : null;
}

const meanText = (ms: number | null) =>
  ms === null ? '—' : formatDuration(ms);

const kindColumns: DataTableColumn<KindRow>[] = [
  {
    key: 'kind',
    header: 'Incident kind',
    cell: (row) => (
      <span className="sim-cell-stack">
        <strong>{row.label}</strong>
        <span className="sim-muted">
          {exceptionClassLabel(row.exceptionClass)}
        </span>
      </span>
    ),
  },
  {
    key: 'total',
    header: 'Total',
    numeric: true,
    cell: (row) => formatCount(row.total),
  },
  {
    key: 'detected',
    header: 'Detected',
    numeric: true,
    cell: (row) => formatCount(row.detected),
  },
  {
    key: 'missed',
    header: 'Missed',
    numeric: true,
    cell: (row) => formatCount(row.missed),
  },
  {
    key: 'pending',
    header: 'Pending',
    numeric: true,
    hideOnNarrow: true,
    cell: (row) => formatCount(row.pending),
  },
  {
    key: 'not-covered',
    header: 'Not covered',
    numeric: true,
    hideOnNarrow: true,
    cell: (row) => formatCount(row.notCovered),
  },
  {
    key: 'mttd',
    header: 'Mean time to detect',
    numeric: true,
    cell: (row) => meanText(row.meanTimeToDetectMs),
  },
];

const falsePositiveColumns: DataTableColumn<FalsePositive>[] = [
  {
    key: 'case',
    header: 'Case',
    cell: (row) =>
      row.url ? (
        <a href={row.url} target="_blank" rel="noreferrer">
          {row.id}
          <span className="sr-only"> (opens Luma in a new tab)</span>
        </a>
      ) : (
        <code>{row.id}</code>
      ),
  },
  {
    key: 'class',
    header: 'Exception class',
    cell: (row) => exceptionClassLabel(row.exceptionClass),
  },
  {
    key: 'detected',
    header: 'Detected',
    cell: (row) => formatDateTime(new Date(row.detectedAt).getTime()),
  },
];

const duplicateColumns: DataTableColumn<DuplicateWrite>[] = [
  { key: 'instance', header: 'Instance', cell: (row) => row.instance },
  {
    key: 'operation',
    header: 'Operation',
    cell: (row) => <code>{row.operation}</code>,
  },
  {
    key: 'key',
    header: 'Idempotency key',
    cell: (row) => <code>{row.key}</code>,
  },
  {
    key: 'count',
    header: 'Writes',
    numeric: true,
    cell: (row) => formatCount(row.count),
  },
];

/**
 * Compares ground-truth incidents with Luma's cases: what was detected, missed or never
 * covered, how fast, and what Luma got wrong (false positives, duplicate writes, cases closed
 * without verification).
 */
export function ScorecardView({ run }: { run: RunDetail }) {
  const scorecard = useScorecard(run.id);
  if (scorecard.isPending) return <Loading label="Loading the scorecard" />;
  if (scorecard.isError)
    return (
      <LoadError
        title="Scorecard unavailable"
        error={scorecard.error}
        onRetry={() => void scorecard.refetch()}
      />
    );
  const { totals, luma } = scorecard.data;
  const rate = detectionRate(totals);

  return (
    <div className="sim-stack">
      <div className="sim-toolbar">
        <h2 className="sim-section-title">Scorecard</h2>
        <span className="sim-muted">
          Generated {formatDateTime(scorecard.data.generatedAt)} simulation time
        </span>
      </div>
      {luma.connected ? (
        <Alert tone="success">
          <AlertTitle>Luma connected</AlertTitle>
          <AlertDescription>
            Detection compares incidents with cases in the attached workspace.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert tone="warning">
          <AlertTitle>Luma not connected</AlertTitle>
          <AlertDescription>
            {luma.error ??
              'No Luma workspace is attached, so detection stays pending.'}
          </AlertDescription>
        </Alert>
      )}
      <div className="sim-tiles">
        <MetricTile label="Incidents" value={formatCount(totals.incidents)} />
        <MetricTile
          label="Detected"
          value={formatCount(totals.detected)}
          detail={
            rate === null
              ? 'No incident decided yet'
              : `${formatPercent(rate)} of decided incidents`
          }
        />
        <MetricTile label="Missed" value={formatCount(totals.missed)} />
        <MetricTile
          label="Pending"
          value={formatCount(totals.pending)}
          detail="Still within the detection window"
        />
        <MetricTile
          label="Not covered"
          value={formatCount(totals.notCovered)}
          detail="No Luma rule detects these kinds"
        />
        <MetricTile
          label="Mean time to detect"
          value={
            scorecard.data.meanTimeToDetectMs === null
              ? null
              : formatDuration(scorecard.data.meanTimeToDetectMs)
          }
        />
        <MetricTile
          label="False positives"
          value={formatCount(totals.falsePositives)}
          detail="Cases without a matching incident"
        />
        <MetricTile
          label="Closed without verification"
          value={formatCount(totals.closedWithoutVerification)}
        />
        <MetricTile
          label="Duplicate writes"
          value={formatCount(totals.duplicateWrites)}
          detail="Repeated external effects for one intent"
        />
      </div>
      <Card as="section" aria-labelledby="scorecard-kinds">
        <CardHeader>
          <CardTitle id="scorecard-kinds">By incident kind</CardTitle>
        </CardHeader>
        <DataTable
          caption="Detection by incident kind"
          columns={kindColumns}
          rows={scorecard.data.byKind}
          rowKey={(row) => row.kind}
          density="compact"
          variant="plain"
          empty={<p className="sim-muted">No incidents yet.</p>}
        />
      </Card>
      <Card as="section" aria-labelledby="scorecard-false-positives">
        <CardHeader>
          <div>
            <CardTitle id="scorecard-false-positives">
              False positives
            </CardTitle>
            <CardDescription>
              Luma cases that no simulated incident explains.
            </CardDescription>
          </div>
        </CardHeader>
        <DataTable
          caption="False positives"
          columns={falsePositiveColumns}
          rows={scorecard.data.falsePositives}
          rowKey={(row) => row.id}
          density="compact"
          variant="plain"
          empty={<p className="sim-muted">No false positives.</p>}
        />
      </Card>
      <Card as="section" aria-labelledby="scorecard-duplicates">
        <CardHeader>
          <div>
            <CardTitle id="scorecard-duplicates">Duplicate writes</CardTitle>
            <CardDescription>
              Writes the providers received more than once for the same key.
            </CardDescription>
          </div>
        </CardHeader>
        <DataTable
          caption="Duplicate writes"
          columns={duplicateColumns}
          rows={scorecard.data.duplicateWrites}
          rowKey={(row) => `${row.instance}:${row.operation}:${row.key}`}
          density="compact"
          variant="plain"
          empty={<p className="sim-muted">No duplicate writes.</p>}
        />
      </Card>
    </div>
  );
}
