import type { WorkflowRunView, WorkflowVersionView } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Square } from 'lucide-react';
import { useState } from 'react';

import { cancelCodeStep } from './code-data';

type CodeOutcome = NonNullable<
  NonNullable<WorkflowRunView['processSteps']>[number]['code']
>['outcome'];

/** Short labels for how a code step ended. */
const codeOutcomeLabels = {
  completed: m.workflows_code_outcome_completed,
  code_error: m.workflows_code_outcome_code_error,
  resource_limit: m.workflows_code_outcome_resource_limit,
  cancelled: m.workflows_code_outcome_cancelled,
  invalid_output: m.workflows_code_outcome_invalid_output,
  capability_denied: m.workflows_code_outcome_capability_denied,
  unavailable: m.workflows_code_outcome_unavailable,
} satisfies Record<CodeOutcome, () => string>;

/** Shows isolated code results and lets people who can manage workflow triggers stop unfinished code instructions. */
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
      setError(m.workflows_code_run_stop_failed());
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
              {m.workflows_code_run_summary({
                step: step.id,
                status: record?.code
                  ? codeOutcomeLabels[record.code.outcome]()
                  : stopped.includes(step.id)
                    ? m.workflows_code_run_stop_requested()
                    : m.workflows_code_run_pending(),
              })}
            </summary>
            {record?.code ? (
              <>
                <p>
                  {m.workflows_code_run_telemetry({
                    duration: formatNumber(record.code.wallTimeMs),
                    requests: record.code.requests,
                  })}
                </p>
                <pre>{JSON.stringify(record.values, null, 2)}</pre>
                <p>
                  {m.workflows_code_run_input_fingerprint()}{' '}
                  <code>{record.code.inputDigest}</code>
                </p>
              </>
            ) : canManage &&
              !terminal &&
              !['scheduled', 'cancelled'].includes(run.triggerState ?? '') ? (
              <>
                <p>{m.workflows_code_run_stop_help()}</p>
                <Button
                  variant="outline"
                  disabled={!!pending || stopped.includes(step.id)}
                  onClick={() => void stop(step.id)}
                >
                  <Square size={14} />
                  {stopped.includes(step.id)
                    ? m.workflows_code_run_stop_requested()
                    : m.workflows_code_run_stop()}
                </Button>
              </>
            ) : (
              <p>{m.workflows_code_run_no_result()}</p>
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
