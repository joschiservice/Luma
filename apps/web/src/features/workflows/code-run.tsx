import type { WorkflowRunView, WorkflowVersionView } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Square } from 'lucide-react';
import { useState } from 'react';

import { cancelCodeStep } from './code-data';

/** Shows sandbox evidence and lets people who can manage workflow triggers stop unfinished code instructions. */
export function CodeRunDetails({
  run,
  version,
  organizationId,
  definitionId,
  canManage,
  refresh,
}: {
  run: WorkflowRunView;
  version: WorkflowVersionView | undefined;
  organizationId: string;
  definitionId: string;
  canManage: boolean;
  refresh: () => Promise<void>;
}) {
  const [pending, setPending] = useState('');
  const [stopped, setStopped] = useState<string[]>([]);
  const [error, setError] = useState('');
  if (version?.format !== 'workflow/2' || !version.codeSteps?.length)
    return null;
  const terminal =
    run.processState &&
    !['running', 'waiting', 'awaiting_decision'].includes(run.processState);

  async function stop(stepId: string) {
    setPending(stepId);
    setError('');
    try {
      await cancelCodeStep(organizationId, definitionId, run.id, stepId);
      setStopped((items) => [...items, stepId]);
      await refresh();
    } catch {
      setError('Cancellation could not be confirmed. Refresh and try again.');
    } finally {
      setPending('');
    }
  }

  return (
    <div className="code-step-list">
      {version.codeSteps.map((step) => {
        const record = run.processSteps?.find(
          (item) => item.stepId === step.id && item.state !== 'waiting',
        );

        return (
          <Disclosure key={step.id}>
            <summary>
              {step.id} ·{' '}
              {record?.code?.outcome.replaceAll('_', ' ') ??
                (stopped.includes(step.id)
                  ? 'Stop requested'
                  : 'Code execution')}
            </summary>
            {record?.code ? (
              <>
                <p>
                  {record.code.wallTimeMs} ms · {record.code.requests}{' '}
                  capability requests
                </p>
                <pre>{JSON.stringify(record.values, null, 2)}</pre>
                <p>
                  Input digest: <code>{record.code.inputDigest}</code>
                </p>
              </>
            ) : canManage &&
              !terminal &&
              !['scheduled', 'cancelled'].includes(run.triggerState ?? '') ? (
              <>
                <p>
                  Stopping prevents new requests. Already admitted actions may
                  still complete.
                </p>
                <Button
                  variant="outline"
                  disabled={!!pending || stopped.includes(step.id)}
                  onClick={() => void stop(step.id)}
                >
                  <Square size={14} />
                  {stopped.includes(step.id) ? 'Stop requested' : 'Stop code'}
                </Button>
              </>
            ) : (
              <p>No code result recorded.</p>
            )}
          </Disclosure>
        );
      })}
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}
