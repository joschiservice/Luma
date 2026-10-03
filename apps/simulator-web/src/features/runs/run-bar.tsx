import type { RunSummary } from '@luma/simulator-contract';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { Select } from '@luma/ui/components/primitives/select';
import {
  type OperationalState,
  StatePill,
} from '@luma/ui/components/primitives/state';
import { Pause, Play } from 'lucide-react';
import { useState } from 'react';

import { errorMessage } from '../../api';
import { ConfirmDialog } from '../../components/confirm-dialog';
import {
  describeOffset,
  formatDateTime,
  runStatusText,
  speedLabel,
} from '../../lib/format';
import { useNow } from '../../lib/use-now';
import { useControl, useDeleteRun } from '../../queries';
import { presetLabel } from './create-run-dialog';

const speeds = [1, 2, 5, 10, 30, 60, 100];

const advances = [
  { ms: 30_000, label: '30 s' },
  { ms: 300_000, label: '5 min' },
  { ms: 3_600_000, label: '1 h' },
];

const statusState: Record<RunSummary['status'], OperationalState> = {
  provisioning: 'running',
  ready: 'verified',
  failed: 'error',
};

/**
 * Estimates the simulation clock between polls from the last reading, its speed and the time
 * it was fetched, so the displayed time keeps moving while the run is running.
 */
function useSimulationTime(run: RunSummary, fetchedAt: number) {
  const running = run.clock.running && run.status === 'ready';
  const now = useNow(1_000, running);
  const elapsed = running ? Math.max(0, now - fetchedAt) * run.clock.speed : 0;

  return run.clock.now + elapsed;
}

/**
 * The selected run's lifecycle, clock and time controls. Status changes are announced; the
 * ticking clock is not. Advancing or fast-forwarding moves the run ahead of real time, which
 * the bar states next to the clock.
 */
export function RunBar({
  run,
  clockFetchedAt,
  onDeleted,
}: {
  run: RunSummary;
  clockFetchedAt: number;
  onDeleted: () => void;
}) {
  const control = useControl(run.id);
  const [resetOpen, setResetOpen] = useState(false);
  const ready = run.status === 'ready';
  const time = useSimulationTime(run, clockFetchedAt);
  const offset = describeOffset(run.clock.offsetMs);
  const busy = control.isPending;
  const speedOptions = [...new Set([...speeds, run.clock.speed])]
    .sort((a, b) => a - b)
    .map((speed) => ({ value: String(speed), label: speedLabel(speed) }));

  return (
    <Card
      as="section"
      aria-label="Run clock and controls"
      className="sim-runbar"
    >
      <div className="sim-runbar-identity">
        <StatePill state={statusState[run.status]}>
          {runStatusText(run)}
        </StatePill>
        <h1 className="sim-run-title">{run.id}</h1>
        <span className="sim-muted">
          {run.profile.label} · {presetLabel(run.chaos.preset)} · seed{' '}
          {run.seed}
        </span>
      </div>
      <p className="sr-only" aria-live="polite">
        {`Run ${run.id}: ${run.status}, ${run.clock.running ? 'running' : 'paused'}, ${speedLabel(run.clock.speed)}.`}
      </p>
      <div className="sim-runbar-clock">
        <div>
          <span className="sim-label">Simulation time</span>
          <time
            className="sim-clock lu-numeric"
            dateTime={new Date(time).toISOString()}
          >
            {formatDateTime(time)}
          </time>
        </div>
        <div className="sim-runbar-states">
          <StatePill state={run.clock.running ? 'running' : 'idle'}>
            {run.clock.running ? 'Running' : 'Paused'}
          </StatePill>
          {run.clock.speed === 1 ? null : (
            <Badge tone="info">{speedLabel(run.clock.speed)}</Badge>
          )}
          <Badge tone={offset.state === 'ahead' ? 'warning' : 'neutral'}>
            {offset.text}
          </Badge>
        </div>
      </div>
      <div className="sim-runbar-controls">
        {run.clock.running ? (
          <Button
            variant="outline"
            disabled={!ready || busy}
            onClick={() => control.mutate({ action: 'pause' })}
          >
            <Pause aria-hidden="true" />
            Pause
          </Button>
        ) : (
          <Button
            disabled={!ready || busy}
            onClick={() => control.mutate({ action: 'resume' })}
          >
            <Play aria-hidden="true" />
            Start
          </Button>
        )}
        <div
          className="sim-button-group"
          role="group"
          aria-label="Advance the clock"
          aria-describedby={`${run.id}-advance-note`}
        >
          <span className="sim-label" aria-hidden="true">
            Advance
          </span>
          {advances.map((advance) => (
            <Button
              key={advance.ms}
              variant="outline"
              size="sm"
              disabled={!ready || busy}
              aria-label={`Advance ${advance.label}`}
              onClick={() =>
                control.mutate({ action: 'advance', milliseconds: advance.ms })
              }
            >
              +{advance.label}
            </Button>
          ))}
        </div>
        <Select
          aria-label="Clock speed"
          className="sim-speed-select"
          value={String(run.clock.speed)}
          disabled={!ready || busy}
          options={speedOptions}
          onValueChange={(value) => {
            if (value)
              control.mutate({ action: 'speed', speed: Number(value) });
          }}
        />
        <ConfirmDialog
          triggerLabel="Reset run"
          disabled={!ready}
          title={`Reset ${run.id}?`}
          description="Resetting regenerates the merchant world from its seed. Orders, incidents, faults and journal entries created since provisioning are discarded."
          confirmLabel="Reset run"
          open={resetOpen}
          onOpenChange={setResetOpen}
          pending={busy}
          error={control.isError ? errorMessage(control.error) : null}
          onConfirm={() =>
            control.mutate(
              { action: 'reset' },
              { onSuccess: () => setResetOpen(false) },
            )
          }
        />
        <DeleteRunButton run={run} onDeleted={onDeleted} />
      </div>
      <p id={`${run.id}-advance-note`} className="sim-note">
        Advancing or fast-forwarding moves the simulation ahead of real time.
      </p>
      {offset.state === 'ahead' ? (
        <Alert tone="warning">
          <AlertTitle>Timing-based Luma rules are invalid</AlertTitle>
          <AlertDescription>
            The simulation is {offset.text.toLowerCase()}. Luma compares record
            times with its own clock, so overdue, stuck-fulfillment and
            freshness checks give wrong results until real time catches up.
          </AlertDescription>
        </Alert>
      ) : null}
      {control.isError && !resetOpen ? (
        <Alert tone="danger" role="alert">
          <AlertTitle>Control failed</AlertTitle>
          <AlertDescription>{errorMessage(control.error)}</AlertDescription>
        </Alert>
      ) : null}
    </Card>
  );
}

/** Deletes a run after confirmation. */
function DeleteRunButton({
  run,
  onDeleted,
}: {
  run: RunSummary;
  onDeleted: () => void;
}) {
  const remove = useDeleteRun();
  const [open, setOpen] = useState(false);

  return (
    <ConfirmDialog
      triggerLabel="Delete run"
      title={`Delete ${run.id}?`}
      description="The run, its provider data and its journal are removed. Luma keeps the cases it opened."
      confirmLabel="Delete run"
      open={open}
      onOpenChange={setOpen}
      pending={remove.isPending}
      error={remove.isError ? errorMessage(remove.error) : null}
      onConfirm={() =>
        remove.mutate(run.id, {
          onSuccess: () => {
            setOpen(false);
            onDeleted();
          },
        })
      }
    />
  );
}
