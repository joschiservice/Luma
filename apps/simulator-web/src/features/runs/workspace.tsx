import type { RunSummary } from '@luma/simulator-contract';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@luma/ui/components/primitives/alert';
import { LumaMark } from '@luma/ui/components/primitives/brand';
import { Card } from '@luma/ui/components/primitives/card';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Progress } from '@luma/ui/components/primitives/progress';
import { Select } from '@luma/ui/components/primitives/select';
import { FlaskConical } from 'lucide-react';

import { isUnauthorized, isUnreachable } from '../../api';
import { LoadError, Loading } from '../../components/query-state';
import { progressText } from '../../lib/format';
import { useSearchParam } from '../../lib/location';
import { useRun, useRuns } from '../../queries';
import { ConnectPanel, TokenDialog } from './connection';
import { CreateRunDialog } from './create-run-dialog';
import { RunBar } from './run-bar';
import { RunTabs } from './run-tabs';

const runPattern = /^[a-z0-9-]{1,64}$/;
const isRunId = (value: string): value is string => runPattern.test(value);

/**
 * The control panel's frame: run selection, the selected run's clock and controls, and its
 * views. Each state says what is happening: connecting, rejected, empty, provisioning or failed.
 */
export function Workspace() {
  const runs = useRuns();
  const [runParam, setRunParam] = useSearchParam('run', '', isRunId);
  const list = runs.data ?? [];
  const summary = list.find((run) => run.id === runParam) ?? list[0] ?? null;
  const detail = useRun(summary?.id ?? null);
  const current =
    detail.data && detail.data.id === summary?.id ? detail.data : summary;

  return (
    <div className="sim-app">
      <header className="sim-topbar">
        <div className="sim-brand">
          <LumaMark />
          <span>
            Luma <span className="sim-muted">Simulator</span>
          </span>
        </div>
        <div className="sim-topbar-actions">
          {list.length > 0 && summary ? (
            <Select
              aria-label="Run"
              className="sim-run-select"
              value={summary.id}
              options={list.map((run) => ({
                value: run.id,
                label: `${run.id} · ${run.profile.label}`,
              }))}
              onValueChange={(id) => {
                if (id) setRunParam(id);
              }}
            />
          ) : null}
          {list.length > 0 ? (
            <CreateRunDialog
              existing={list.map((run) => run.id)}
              onCreated={setRunParam}
            />
          ) : null}
          <TokenDialog />
        </div>
      </header>
      <main className="sim-main">
        {runs.isPending ? (
          <Loading label="Connecting to the simulator" />
        ) : runs.isError &&
          (isUnauthorized(runs.error) || isUnreachable(runs.error)) ? (
          <ConnectPanel
            reason={isUnauthorized(runs.error) ? 'rejected' : 'unreachable'}
          />
        ) : runs.isError ? (
          <LoadError
            title="Runs unavailable"
            error={runs.error}
            onRetry={() => void runs.refetch()}
          />
        ) : !current ? (
          <Card>
            <Empty>
              <FlaskConical aria-hidden="true" />
              <h2>No runs yet — create one</h2>
              <p>
                A run simulates a merchant with shops on one ERP, its orders,
                warehouse and failures, starting in real time.
              </p>
              <CreateRunDialog existing={[]} onCreated={setRunParam} />
            </Empty>
          </Card>
        ) : (
          <>
            <RunBar
              run={current}
              clockFetchedAt={clockTime(detail, runs)}
              onDeleted={() => setRunParam(null)}
            />
            <RunContent run={current} detail={detail} />
          </>
        )}
      </main>
    </div>
  );
}

function clockTime(
  detail: { dataUpdatedAt: number; data?: RunSummary | undefined },
  runs: { dataUpdatedAt: number },
) {
  return detail.data ? detail.dataUpdatedAt : runs.dataUpdatedAt;
}

function RunContent({
  run,
  detail,
}: {
  run: RunSummary;
  detail: ReturnType<typeof useRun>;
}) {
  if (run.status === 'provisioning')
    return (
      <Card as="section" aria-labelledby="provisioning-title">
        <h2 id="provisioning-title" className="sim-section-title">
          Run is provisioning
        </h2>
        <p className="sim-muted">
          {progressText(run.progress)}. Views open when the merchant world is
          ready.
        </p>
        <Progress
          className="sim-progress"
          label="Provisioning progress"
          value={
            run.progress && run.progress.total > 0 ? run.progress.done : null
          }
          max={run.progress?.total || 100}
          valueText={progressText(run.progress)}
        />
      </Card>
    );
  if (run.status === 'failed')
    return (
      <Alert tone="danger">
        <AlertTitle>Run failed to provision</AlertTitle>
        <AlertDescription>
          <p>{run.error ?? 'The simulator did not report a reason.'}</p>
          <p className="sim-muted">Delete the run and create it again.</p>
        </AlertDescription>
      </Alert>
    );
  if (detail.isError)
    return (
      <LoadError
        title="Run details unavailable"
        error={detail.error}
        onRetry={() => void detail.refetch()}
      />
    );
  if (!detail.data || detail.data.id !== run.id)
    return <Loading label="Loading run details" />;

  return <RunTabs run={detail.data} />;
}
