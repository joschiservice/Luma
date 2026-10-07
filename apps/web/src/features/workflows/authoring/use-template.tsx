import type { WorkflowTemplate } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { contextOptions } from '../../identity/data';
import { ActivationForm } from '../activation';
import { CaseActivationForm } from '../case';
import {
  replenishmentOptions,
  workflowError,
  workflowOptions,
  workflowsKey,
} from '../data';
import { ReplenishmentSetupFlow } from '../replenishment-setup';
import { installTemplate } from './data';

type Stage = 'requirements' | 'configure' | 'done';

/**
 * Guides one template from requirements to an activated scope. Configuration and activation use
 * the workflow's existing activation path, so the same server checks apply.
 */
export function UseTemplateDialog({
  organizationId,
  template,
  close,
}: {
  organizationId: string;
  template: WorkflowTemplate;
  close(): void;
}) {
  const [stage, setStage] = useState<Stage>('requirements');
  const [locked, setLocked] = useState(false);
  const ready = template.readiness === 'ready';

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) close();
      }}
    >
      <DialogContent
        className="workflow-dialog authoring-use-dialog"
        showCloseButton={!locked}
      >
        <DialogTitle>Use “{template.name}”</DialogTitle>
        <DialogDescription>
          {stage === 'requirements'
            ? 'Check what this workflow needs, then choose where it applies.'
            : stage === 'configure'
              ? 'Choose the exact scope and limits. You review them before anything is activated.'
              : 'The workflow is active for the scope you reviewed.'}
        </DialogDescription>
        <ol className="authoring-stages" aria-label="Progress">
          {(['requirements', 'configure', 'done'] as const).map(
            (item, index) => (
              <li key={item} aria-current={item === stage ? 'step' : undefined}>
                {index + 1}.{' '}
                {item === 'requirements'
                  ? 'Requirements'
                  : item === 'configure'
                    ? 'Configure and review'
                    : 'Active'}
              </li>
            ),
          )}
        </ol>
        {stage === 'requirements' ? (
          <>
            <ul className="authoring-requirements authoring-requirements--dialog">
              {template.requirements.map((item) => (
                <li key={item.label} data-met={item.met}>
                  {item.met ? (
                    <Check size={15} aria-label="Done" />
                  ) : (
                    <TriangleAlert size={15} aria-label="Missing" />
                  )}
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.detail}</span>
                  </div>
                </li>
              ))}
            </ul>
            {!ready ? (
              <Alert tone="warning" role="status">
                Finish the missing items first. The links on the template card
                open the right place.
              </Alert>
            ) : null}
            <div className="workflow-dialog-actions">
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button disabled={!ready} onClick={() => setStage('configure')}>
                Continue
              </Button>
            </div>
          </>
        ) : stage === 'configure' ? (
          template.configure === 'case' ? (
            <CaseStep
              organizationId={organizationId}
              template={template}
              cancel={close}
              done={() => setStage('done')}
            />
          ) : template.configure === 'replenishment' ? (
            <ReplenishmentStep
              organizationId={organizationId}
              template={template}
              lock={setLocked}
              cancel={close}
              done={() => setStage('done')}
            />
          ) : (
            <ResolutionStep
              organizationId={organizationId}
              template={template}
              lock={setLocked}
              cancel={close}
              done={() => setStage('done')}
            />
          )
        ) : (
          <>
            <Alert tone="success" role="status">
              Activated. Runs start when the trigger happens, and each action
              still passes policy and approval checks.
            </Alert>
            <div className="workflow-dialog-actions">
              <Button variant="outline" onClick={close}>
                Back to templates
              </Button>
              <Link
                className={buttonVariants()}
                to="/app/$organizationId/workflows/$definitionId"
                params={{ organizationId, definitionId: template.id }}
              >
                Open workflow
              </Link>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReplenishmentStep({
  organizationId,
  template,
  lock,
  cancel,
  done,
}: {
  organizationId: string;
  template: WorkflowTemplate;
  lock(value: boolean): void;
  cancel(): void;
  done(): void;
}) {
  const client = useQueryClient();
  const detail = useQuery(workflowOptions(organizationId, template.id));
  const setup = useQuery(replenishmentOptions(organizationId));
  const error = detail.error ?? setup.error;

  if (error)
    return (
      <Alert tone="danger" role="alert">
        <span>{workflowError(error)}</span>
        <Button
          variant="outline"
          onClick={() => {
            void detail.refetch();
            void setup.refetch();
          }}
        >
          Retry
        </Button>
      </Alert>
    );
  if (!detail.data || !setup.data)
    return <p role="status">Loading stock positions and suppliers…</p>;

  return (
    <ReplenishmentSetupFlow
      organizationId={organizationId}
      detail={detail.data}
      setup={setup.data}
      onLock={lock}
      done={(changed) => {
        if (!changed) return cancel();
        void client.invalidateQueries({
          queryKey: workflowsKey(organizationId),
        });
        done();
      }}
    />
  );
}

function CaseStep({
  organizationId,
  template,
  cancel,
  done,
}: {
  organizationId: string;
  template: WorkflowTemplate;
  cancel(): void;
  done(): void;
}) {
  const detail = useQuery(workflowOptions(organizationId, template.id));

  if (detail.error)
    return (
      <Alert tone="danger" role="alert">
        <span>{workflowError(detail.error)}</span>
        <Button variant="outline" onClick={() => void detail.refetch()}>
          Retry
        </Button>
      </Alert>
    );
  if (!detail.data) return <p role="status">Loading the workflow…</p>;

  return (
    <CaseActivationForm
      organizationId={organizationId}
      detail={detail.data}
      cancel={cancel}
      done={async () => done()}
    />
  );
}

function ResolutionStep({
  organizationId,
  template,
  lock,
  cancel,
  done,
}: {
  organizationId: string;
  template: WorkflowTemplate;
  lock(value: boolean): void;
  cancel(): void;
  done(): void;
}) {
  const client = useQueryClient();
  const [installed, setInstalled] = useState(template.installed);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const detail = useQuery({
    ...workflowOptions(organizationId, template.id),
    enabled: installed,
  });

  async function install() {
    setPending(true);
    lock(true);
    setError('');
    try {
      await installTemplate(organizationId, template.id);
      setInstalled(true);
    } catch (failure) {
      setError(workflowError(failure));
    } finally {
      setPending(false);
      lock(false);
    }
  }

  if (!installed)
    return (
      <>
        <p>
          Luma adds the reviewed version of this workflow to your workspace
          first. Adding it doesn’t activate anything.
        </p>
        {error ? (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        ) : null}
        <div className="workflow-dialog-actions">
          <Button variant="outline" disabled={pending} onClick={cancel}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={() => void install()}>
            {pending ? 'Adding…' : error ? 'Retry' : 'Add and continue'}
          </Button>
        </div>
      </>
    );
  if (detail.error)
    return (
      <Alert tone="danger" role="alert">
        <span>{workflowError(detail.error)}</span>
        <Button variant="outline" onClick={() => void detail.refetch()}>
          Retry
        </Button>
      </Alert>
    );
  if (!detail.data) return <p role="status">Loading connections…</p>;

  return (
    <ActivationForm
      organizationId={organizationId}
      detail={detail.data}
      version={detail.data.versions[0]!.version}
      cancel={cancel}
      accessLost={async () => {
        await client.invalidateQueries({
          queryKey: contextOptions(organizationId).queryKey,
        });
      }}
      done={async () => {
        await client.invalidateQueries({
          queryKey: workflowsKey(organizationId),
        });
        done();
      }}
    />
  );
}
