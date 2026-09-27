import type {
  WorkflowActivationView,
  WorkflowDetail,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardHeader } from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { SectionWorkspace } from '@luma/ui/components/workspace/section-workspace';
import { WorkspaceBreadcrumb } from '@luma/ui/components/workspace/workspace-breadcrumb';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ChevronRight, RefreshCw, Workflow } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { SignInRedirect } from '../identity/common';
import { contextOptions, IdentityError } from '../identity/data';
import { ShadowReport } from '../shadow/report';
import { ActivationForm } from './activation';
import {
  revokeWorkflow,
  workflowError,
  workflowOptions,
  workflowRunsOptions,
  workflowsKey,
} from './data';
import {
  WorkflowActivations,
  WorkflowCompatibility,
  WorkflowOverview,
  WorkflowSteps,
  WorkflowVersions,
} from './detail-sections';
import { statusNames, type WorkflowFilters, WorkflowLoading } from './library';
import { OfflineNotice } from './offline';
import { workflowTriggerLabel } from './presentation';
import { CancelScheduledStart, WorkflowTriggers } from './triggers';

/** Loads a shareable workflow, resetting private form state when the workspace or workflow changes. */
export function WorkflowPage() {
  const { organizationId, definitionId } = useParams({
    from: '/app/$organizationId/workflows/$definitionId',
  });
  const filters = useSearch({
    from: '/app/$organizationId/workflows/$definitionId',
  });

  return (
    <WorkflowDetailPage
      key={`${organizationId}:${definitionId}`}
      organizationId={organizationId}
      definitionId={definitionId}
      filters={filters}
    />
  );
}

/** Reads current workflow controls and history independently and hides private content after access loss. */
export function WorkflowDetailPage({
  organizationId,
  definitionId,
  filters = {},
}: {
  organizationId: string;
  definitionId: string;
  filters?: WorkflowFilters;
}) {
  const query = useQuery(workflowOptions(organizationId, definitionId));
  const runs = useQuery(workflowRunsOptions(organizationId, definitionId));
  const client = useQueryClient();
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: workflowsKey(organizationId) });
  };
  const accessLost = async () => {
    client.removeQueries({ queryKey: workflowsKey(organizationId) });
    await client.invalidateQueries({
      queryKey: contextOptions(organizationId).queryKey,
    });
    await refresh();
  };
  const accessError = [query.error, runs.error].find(
    (e) => e instanceof IdentityError && [401, 403, 404].includes(e.status),
  );
  if (accessError instanceof IdentityError && accessError.status === 401)
    return <SignInRedirect />;

  return (
    <div className="workflows-page">
      <OfflineNotice />
      {!query.data || accessError ? (
        <Link
          className="workflow-back"
          to="/app/$organizationId/workflows"
          params={{ organizationId }}
          search={filters}
        >
          <ArrowLeft size={15} aria-hidden="true" /> All workflows
        </Link>
      ) : null}
      {query.error || accessError ? (
        <Alert tone="danger" role="alert" className="workflow-notice">
          {workflowError(query.error ?? accessError)}{' '}
          <Button onClick={() => void refresh()} variant="outline">
            Retry
          </Button>
        </Alert>
      ) : null}
      {accessError ? null : query.isPending ? (
        <WorkflowLoading detail />
      ) : query.data ? (
        <WorkflowDetailView
          key={query.data.canManage ? 'manage' : 'read'}
          detail={query.data}
          organizationId={organizationId}
          filters={filters}
          refresh={refresh}
          refreshing={query.isFetching || !!query.error}
          accessLost={accessLost}
          evaluation={
            query.data.canManage &&
            query.data.versions[0]?.format === 'resolution-playbook/0' ? (
              <ShadowReport
                key={`${organizationId}:${definitionId}`}
                organizationId={organizationId}
                workflow={definitionId}
              />
            ) : null
          }
          runs={
            <Card
              as="section"
              className="workflow-section"
              aria-labelledby="runs-title"
            >
              <CardHeader className="workflows-heading">
                <h2 id="runs-title">Recent runs</h2>
                <Button
                  variant="outline"
                  disabled={runs.isFetching}
                  onClick={() => void runs.refetch()}
                >
                  Refresh runs
                </Button>
              </CardHeader>
              <p>
                Execution acceptance and verified correction are separate
                results. Pilot, simulation and shadow evidence are not live
                verified success.
              </p>
              {runs.error ? (
                <p role="alert">
                  Run history is unavailable. {workflowError(runs.error)}
                </p>
              ) : runs.isPending ? (
                <p role="status">Loading runs…</p>
              ) : !runs.data?.length ? (
                <p>No runs recorded for this workflow.</p>
              ) : (
                <div className="workflow-runs">
                  {runs.data.map((run) => (
                    <article key={run.id}>
                      <div className="workflows-heading">
                        {run.resolution ? (
                          <Link
                            to="/app/$organizationId/exceptions/$exceptionId"
                            params={{
                              organizationId,
                              exceptionId: run.resolution.incidentId,
                            }}
                          >
                            Open issue
                          </Link>
                        ) : (
                          <span>{run.subject.kind}</span>
                        )}
                        <time dateTime={run.createdAt}>
                          <WorkspaceDate value={run.createdAt} />
                        </time>
                      </div>
                      <p>
                        Version {run.version} ·{' '}
                        <strong>
                          {run.evidenceKind === 'pilot'
                            ? 'Pilot evidence'
                            : run.evidenceKind === 'unclassified'
                              ? 'Unclassified evidence — live success not established'
                              : `${run.evidenceKind} evidence`}
                        </strong>
                      </p>
                      <p className="workflow-run-trigger">
                        <strong>Triggered by: </strong>
                        {workflowTriggerLabel(run.trigger)}
                      </p>
                      {run.triggerState ? (
                        <Alert
                          tone={
                            run.triggerState === 'scheduled'
                              ? 'neutral'
                              : 'warning'
                          }
                        >
                          {run.reason}
                        </Alert>
                      ) : null}
                      {run.triggerState === 'scheduled' &&
                      query.data.canManage ? (
                        <CancelScheduledStart
                          organizationId={organizationId}
                          definitionId={definitionId}
                          runId={run.id}
                          refresh={refresh}
                        />
                      ) : null}
                      <dl className="workflow-run-story">
                        <div>
                          <dt>Investigation</dt>
                          <dd>{run.story.context}</dd>
                        </div>
                        <div>
                          <dt>Decision & human input</dt>
                          <dd>{run.story.decision}</dd>
                        </div>
                        <div>
                          <dt>Proposed action</dt>
                          <dd>{run.story.action}</dd>
                        </div>
                      </dl>
                      <dl>
                        <div>
                          <dt>Execution</dt>
                          <dd>{run.execution.replaceAll('_', ' ')}</dd>
                        </div>
                        <div>
                          <dt>Verification</dt>
                          <dd>{run.verification.replaceAll('_', ' ')}</dd>
                        </div>
                      </dl>
                      <p className="workflow-run-result">
                        {run.story.verification}
                      </p>
                      <Disclosure>
                        <summary>Run evidence references</summary>
                        <p>Run: {run.id}</p>
                        <p>Activation: {run.activationId ?? 'Not granted'}</p>
                        {run.triggerEvidence ? (
                          <p>
                            Source: {run.triggerEvidence.sourceId} ·{' '}
                            <WorkspaceDate
                              value={run.triggerEvidence.occurredAt}
                            />
                          </p>
                        ) : null}
                        <p>
                          Started by: {run.actor.kind} · {run.actor.id}
                        </p>
                        <p>
                          Subject: {run.subject.kind} · {run.subject.id}
                        </p>
                        <p>
                          Trigger:{' '}
                          {run.trigger.kind === 'exception'
                            ? run.trigger.issueType.replaceAll('_', ' ')
                            : run.trigger.kind}
                        </p>
                        <p>
                          Input snapshot: <code>{run.contextDigest}</code>
                        </p>
                        {run.steps.length ? (
                          <ol>
                            {run.steps.map((step, index) => (
                              <li key={`${step.stepId}:${index}`}>
                                {step.stepId} ·{' '}
                                {step.state.replaceAll('_', ' ')} ·{' '}
                                {step.reason.replaceAll('_', ' ')}
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <p>No step outcome recorded.</p>
                        )}
                        <code>{run.versionDigest}</code>
                      </Disclosure>
                    </article>
                  ))}
                </div>
              )}
            </Card>
          }
        />
      ) : null}
    </div>
  );
}

/** Presents readable steps, version history, prerequisites and exact activation grants. */
export function WorkflowDetailView({
  detail,
  organizationId,
  refresh,
  refreshing,
  accessLost,
  filters = {},
  evaluation,
  runs,
}: {
  detail: WorkflowDetail;
  filters?: WorkflowFilters;
  evaluation?: ReactNode;
  runs?: ReactNode;
  organizationId: string;
  refresh: () => Promise<void>;
  refreshing?: boolean;
  accessLost: () => Promise<void>;
}) {
  const [selected, setSelected] = useState(detail.versions[0]!.version);
  const [activate, setActivate] = useState(false);
  const [revoke, setRevoke] = useState<WorkflowActivationView | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const version =
    detail.versions.find((v) => v.version === selected) ?? detail.versions[0]!;
  const canActivate =
    detail.canManage &&
    version.compatible &&
    detail.connections.some((c) => !c.blockers.length);
  const done = async () => {
    setActivate(false);
    setMessage(
      'Activation saved. This exact version and scope are now permitted.',
    );
    await refresh();
  };
  const revokeSelected = async () => {
    if (!revoke || pending) return;
    setPending(true);
    setError('');
    try {
      await revokeWorkflow(
        organizationId,
        detail.summary.id,
        revoke.id,
        revoke.artifactDigest,
      );
      setRevoke(null);
      setMessage(
        'Activation revoked. Future runs are blocked; work already dispatched may still complete.',
      );
      await refresh();
    } catch (error) {
      setError(workflowError(error));
      if (error instanceof IdentityError && [401, 403].includes(error.status))
        await accessLost();
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <WorkspaceBreadcrumb>
        <Workflow size={16} aria-hidden="true" />
        <Link
          to="/app/$organizationId/workflows"
          params={{ organizationId }}
          search={filters}
        >
          Workflows
        </Link>
        <ChevronRight size={14} aria-hidden="true" />
        <span aria-current="page" title={detail.summary.name}>
          {detail.summary.name}
        </span>
      </WorkspaceBreadcrumb>
      <h1 className="sr-only">{detail.summary.name}</h1>
      <div className="workflow-action-bar">
        <Link
          className="workflow-back"
          to="/app/$organizationId/workflows"
          params={{ organizationId }}
          search={filters}
        >
          <ArrowLeft size={15} aria-hidden="true" /> All workflows
        </Link>
        <Badge
          tone={
            detail.summary.status === 'active'
              ? 'success'
              : detail.summary.status === 'unavailable'
                ? 'warning'
                : 'neutral'
          }
        >
          {statusNames[detail.summary.status]}
        </Badge>
        <Button
          variant="ghost"
          aria-label="Refresh workflow"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </Button>
        <div className="workflow-version-controls">
          <Select
            aria-label="Version"
            value={version.version}
            onValueChange={(value) => {
              if (value === null) return;
              setSelected(value);
              setActivate(false);
            }}
            options={detail.versions.map((v) => ({
              value: v.version,
              label: `v${v.version}${v.version === detail.summary.availableVersion ? ' · Latest' : ''}`,
            }))}
          />
          <Button
            disabled={!canActivate || refreshing}
            aria-describedby={
              !canActivate ? 'workflow-activation-reason' : undefined
            }
            onClick={() => setActivate(true)}
          >
            Review activation
          </Button>
        </div>
      </div>
      {!canActivate ? (
        <Alert
          id="workflow-activation-reason"
          tone={detail.canManage ? 'warning' : 'neutral'}
          className="workflow-notice"
        >
          {!detail.canManage
            ? 'You can inspect workflows. Only workspace owners and admins can activate or revoke them.'
            : !version.compatible
              ? 'This version cannot be activated. Review the compatibility requirements below.'
              : 'No eligible connections. Resolve the connection requirements below before activating.'}
        </Alert>
      ) : null}
      {message ? (
        <Alert tone="success" role="status" className="workflow-notice">
          {message}
        </Alert>
      ) : null}
      <SectionWorkspace
        label="Workflow sections"
        sections={[
          {
            value: 'overview',
            label: 'Overview',
            content: <WorkflowOverview detail={detail} version={version} />,
          },
          {
            value: 'triggers',
            label: 'Triggers',
            content: (
              <WorkflowTriggers
                key={version.digest}
                detail={detail}
                version={version}
                organizationId={organizationId}
                refresh={refresh}
                accessLost={accessLost}
              />
            ),
          },
          {
            value: 'steps',
            label: 'How it works',
            content: <WorkflowSteps version={version} />,
          },
          {
            value: 'compatibility',
            label: 'Compatibility',
            content: (
              <WorkflowCompatibility
                detail={detail}
                version={version}
                organizationId={organizationId}
              />
            ),
          },
          {
            value: 'activations',
            label: 'Activations',
            content: (
              <WorkflowActivations
                detail={detail}
                refreshing={refreshing}
                onRevoke={(activation) => {
                  setRevoke(activation);
                  setError('');
                }}
              />
            ),
          },
          ...(runs
            ? [{ value: 'runs', label: 'Recent runs', content: runs }]
            : []),
          ...(evaluation
            ? [
                {
                  value: 'evaluation',
                  label: 'Evaluation',
                  content: evaluation,
                },
              ]
            : []),
          {
            value: 'versions',
            label: 'Version history',
            content: <WorkflowVersions detail={detail} />,
          },
        ]}
      />
      <Dialog open={activate && detail.canManage} onOpenChange={setActivate}>
        <DialogContent className="workflow-dialog">
          <DialogTitle>Review activation</DialogTitle>
          <DialogDescription>
            Confirm the exact version, connection, orders and approval behavior
            before granting access.
          </DialogDescription>
          <ActivationForm
            key={`${selected}:${activate}`}
            organizationId={organizationId}
            detail={detail}
            version={version.version}
            done={done}
            cancel={() => setActivate(false)}
            accessLost={accessLost}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={revoke !== null && detail.canManage}
        onOpenChange={(open) => {
          if (!open && !pending) setRevoke(null);
        }}
      >
        <DialogContent className="workflow-dialog">
          <DialogTitle>Revoke activation?</DialogTitle>
          <DialogDescription>
            This stops future runs under this activation. Work already
            dispatched may still complete. Existing changes are not undone.
          </DialogDescription>
          <p>
            Version {revoke?.version} · {revoke?.grants.targetIds.length} orders
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <div className="workflow-dialog-actions">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setRevoke(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void revokeSelected()}
            >
              {pending ? 'Confirming revocation…' : 'Confirm revocation'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
