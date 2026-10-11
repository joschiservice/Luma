import type { WorkflowTemplate } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
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

import { contextOptions } from '../../../kit/identity/data';
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
        <DialogTitle>
          {m.authoring_use_title({ template: template.name })}
        </DialogTitle>
        <DialogDescription>
          {stage === 'requirements'
            ? m.authoring_use_requirements_description()
            : stage === 'configure'
              ? m.authoring_use_configure_description()
              : m.authoring_use_done_description()}
        </DialogDescription>
        <ol
          className="authoring-stages"
          aria-label={m.authoring_use_progress_label()}
        >
          {(['requirements', 'configure', 'done'] as const).map(
            (item, index) => (
              <li key={item} aria-current={item === stage ? 'step' : undefined}>
                {m.authoring_use_stage({
                  position: index + 1,
                  stage:
                    item === 'requirements'
                      ? m.authoring_use_stage_requirements()
                      : item === 'configure'
                        ? m.authoring_use_stage_configure()
                        : m.authoring_template_active(),
                })}
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
                    <Check
                      size={15}
                      aria-label={m.authoring_requirement_met()}
                    />
                  ) : (
                    <TriangleAlert
                      size={15}
                      aria-label={m.authoring_requirement_missing()}
                    />
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
                {m.authoring_use_missing()}
              </Alert>
            ) : null}
            <div className="workflow-dialog-actions">
              <Button variant="outline" onClick={close}>
                {m.common_cancel()}
              </Button>
              <Button disabled={!ready} onClick={() => setStage('configure')}>
                {m.common_continue()}
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
              {m.authoring_use_activated()}
            </Alert>
            <div className="workflow-dialog-actions">
              <Button variant="outline" onClick={close}>
                {m.authoring_use_back()}
              </Button>
              <Link
                className={buttonVariants()}
                to="/app/$organizationId/workflows/$definitionId"
                params={{ organizationId, definitionId: template.id }}
              >
                {m.authoring_open_workflow()}
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
          {m.common_retry()}
        </Button>
      </Alert>
    );
  if (!detail.data || !setup.data)
    return <p role="status">{m.authoring_use_loading_replenishment()}</p>;

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
          {m.common_retry()}
        </Button>
      </Alert>
    );
  if (!detail.data)
    return <p role="status">{m.authoring_use_loading_workflow()}</p>;

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
        <p>{m.authoring_use_install_description()}</p>
        {error ? (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        ) : null}
        <div className="workflow-dialog-actions">
          <Button variant="outline" disabled={pending} onClick={cancel}>
            {m.common_cancel()}
          </Button>
          <Button disabled={pending} onClick={() => void install()}>
            {pending
              ? m.authoring_use_installing()
              : error
                ? m.common_retry()
                : m.authoring_use_install()}
          </Button>
        </div>
      </>
    );
  if (detail.error)
    return (
      <Alert tone="danger" role="alert">
        <span>{workflowError(detail.error)}</span>
        <Button variant="outline" onClick={() => void detail.refetch()}>
          {m.common_retry()}
        </Button>
      </Alert>
    );
  if (!detail.data)
    return <p role="status">{m.authoring_use_loading_connections()}</p>;

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
