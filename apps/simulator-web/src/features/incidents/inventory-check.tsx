import type { OperationsStatus, RunDetail } from '@luma/simulator-contract';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  type OperationalState,
  StatePill,
} from '@luma/ui/components/primitives/state';

import { errorMessage } from '../../api';
import { formatDateTime, formatTime } from '../../lib/format';
import { incidentStatusText } from '../../lib/labels';
import { useCheckOperations, useIncidents, useOperations } from '../../queries';

const inventoryKinds = new Set(['inventory-drift', 'oversell']);

function checkText(status: OperationsStatus | undefined, failed: boolean) {
  if (failed || status?.unavailable)
    return 'Luma is unavailable. Waiting to reconnect.';
  if (!status?.connected)
    return 'No Luma workspace is attached to this run. Start the run with pnpm simulator to detect and resolve issues in Luma.';
  const check = status.lastCheck;
  if (!check) return 'Ready. Check the current stock with Check now.';
  switch (check.outcome) {
    case 'unavailable':
      return 'The check could not complete. Restore provider service and check again.';
    case 'defer':
      return 'Luma needs complete, comparable stock evidence. An open case stays open.';
    case 'detect':
      return `Checked ${formatTime(new Date(check.at).getTime())}: mismatch detected.`;
    case 'clear':
      return `Checked ${formatTime(new Date(check.at).getTime())}: stock agrees.`;
  }
}

function caseState(status: OperationsStatus | undefined): {
  state: OperationalState;
  text: string;
} {
  const incident = status?.incident;
  if (!incident) return { state: 'idle', text: 'No case yet' };
  if (incident.state === 'resolved')
    return { state: 'verified', text: 'Case resolved' };

  return {
    state: 'attention',
    text: `Case open · ${incident.state.replaceAll('_', ' ')}`,
  };
}

/**
 * Luma's inventory check for this run. The provider problem and Luma's case are shown apart:
 * recovering the incident removes the problem, but the case resolves only after Luma verifies
 * both systems agree.
 */
export function InventoryCheck({ run }: { run: RunDetail }) {
  const operations = useOperations(run.id);
  const incidents = useIncidents(run.id);
  const check = useCheckOperations(run.id);
  const status = operations.data;
  const problem = (incidents.data ?? [])
    .filter((incident) => inventoryKinds.has(incident.kind))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const luma = caseState(status);
  const usable =
    !!status?.connected && !status.unavailable && !operations.isError;

  return (
    <Card as="section" aria-labelledby="inventory-check-title">
      <CardHeader>
        <div>
          <CardTitle id="inventory-check-title">Luma inventory check</CardTitle>
          <CardDescription>
            Luma reads ERP and shop stock and investigates differences.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          disabled={!usable || check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? 'Checking…' : 'Check now'}
        </Button>
      </CardHeader>
      <dl className="sim-facts">
        <div>
          <dt>Provider problem</dt>
          <dd>
            {problem ? (
              <StatePill
                state={
                  problem.status === 'recovered' ? 'verified' : 'attention'
                }
              >
                {problem.status === 'recovered'
                  ? 'Problem removed'
                  : `${problem.label}: ${incidentStatusText(problem).toLowerCase()}`}
              </StatePill>
            ) : (
              <span className="sim-muted">No stock incident in this run</span>
            )}
            {problem?.endedAt ? (
              <span className="sim-muted">
                {' '}
                Removed {formatDateTime(problem.endedAt)}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Luma case</dt>
          <dd>
            <StatePill state={luma.state}>{luma.text}</StatePill>
            {status?.caseUrl ? (
              <>
                {' '}
                <a href={status.caseUrl} target="_blank" rel="noreferrer">
                  Open case in Luma<span className="sr-only"> (new tab)</span>
                </a>
              </>
            ) : null}
          </dd>
        </div>
      </dl>
      <p className="sim-muted" role="status">
        {check.isPending ? 'Checking…' : checkText(status, operations.isError)}
      </p>
      {check.isError ? (
        <p className="sim-error-text" role="alert">
          Check failed: {errorMessage(check.error)}
        </p>
      ) : null}
    </Card>
  );
}
