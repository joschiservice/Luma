import './workflows.css';

import type {
  WorkflowActivationView,
  WorkflowDetail,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Select } from '@luma/ui/components/primitives/select';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { SectionWorkspace } from '@luma/ui/components/workspace/section-workspace';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useLocation,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { SignInRedirect } from '../identity/common';
import { contextOptions, IdentityError } from '../identity/data';
import { ShadowReport } from '../shadow/report';
import { ActivationForm } from './activation';
import { EditWorkflowButton } from './authoring/edit-workflow';
import { WorkflowCodeSteps } from './code-steps';
import {
  revokeWorkflow,
  workflowError,
  workflowOptions,
  workflowRunsOptions,
  workflowsKey,
} from './data';
import {
  WorkflowActivations,
  WorkflowOverview,
  WorkflowTechnical,
} from './detail-sections';
import { workflowDomainView } from './domain-views';
import { type WorkflowFilters, WorkflowLoading } from './library';
import { OfflineNotice } from './offline';
import { ReadinessPills } from './readiness';
import { WorkflowRuns } from './runs';
import { WorkflowTriggers } from './triggers';

/** Loads a shareable workflow, resetting private form state when the workspace or workflow changes. */
export function WorkflowPage() {
  const { organizationId, definitionId } = useParams({
    from: '/app/$organizationId/workflows/$definitionId',
  });
  const { setup, ...filters } = useSearch({
    from: '/app/$organizationId/workflows/$definitionId',
  });

  return (
    <WorkflowDetailPage
      key={`${organizationId}:${definitionId}`}
      organizationId={organizationId}
      definitionId={definitionId}
      filters={filters}
      setup={setup}
    />
  );
}

/**
 * Scrolls to and focuses the element named by the URL hash, such as `rules` or `run-<id>`, once
 * it has rendered.
 */
function useHashTarget(ready: unknown) {
  const hash = useLocation({ select: (location) => location.hash });
  useEffect(() => {
    if (!hash) return;
    const target = document.getElementById(hash);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
  }, [hash, ready]);
}

/** Reads current workflow controls and history independently and hides private content after access loss. */
export function WorkflowDetailPage({
  organizationId,
  definitionId,
  filters = {},
  setup,
}: {
  organizationId: string;
  definitionId: string;
  filters?: WorkflowFilters;
  setup?: string | undefined;
}) {
  const query = useQuery(workflowOptions(organizationId, definitionId));
  const runs = useQuery({
    ...workflowRunsOptions(organizationId, definitionId),
    refetchInterval: 5000,
  });
  useHashTarget(`${!!query.data}:${!!runs.data}`);
  const domainView = query.data ? workflowDomainView(query.data) : undefined;
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
      {query.error || accessError ? (
        <Alert tone="danger" role="alert" className="workflow-notice">
          {workflowError(query.error ?? accessError)}{' '}
          <Button onClick={() => void refresh()} variant="outline">
            {m.common_retry()}
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
          setup={setup}
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
            <WorkflowRuns
              detail={query.data}
              organizationId={organizationId}
              runs={runs.data}
              loading={runs.isPending}
              error={runs.error ? workflowError(runs.error) : undefined}
              refreshing={runs.isFetching}
              refetch={() => void runs.refetch()}
              refresh={refresh}
              RunContext={domainView?.RunContext}
            />
          }
        />
      ) : null}
    </div>
  );
}

/**
 * Groups a workflow into Overview, Activity, Rules and Technical details. Readiness and the next
 * action come first; identifiers and artifacts stay one level down.
 */
export function WorkflowDetailView({
  detail,
  organizationId,
  refresh,
  refreshing,
  accessLost,
  filters = {},
  setup,
  evaluation,
  runs,
}: {
  detail: WorkflowDetail;
  filters?: WorkflowFilters;
  /** A stock position to preselect in stock-rule setup. */
  setup?: string | undefined;
  evaluation?: ReactNode;
  runs?: ReactNode;
  organizationId: string;
  refresh: () => Promise<void>;
  refreshing?: boolean;
  accessLost: () => Promise<void>;
}) {
  const domainView = workflowDomainView(detail);
  const DomainControls = domainView?.Controls;
  const [selected, setSelected] = useState(detail.versions[0]!.version);
  const [activate, setActivate] = useState(false);
  const [revoke, setRevoke] = useState<WorkflowActivationView | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const version =
    detail.versions.find((v) => v.version === selected) ?? detail.versions[0]!;
  const computation =
    version.format === 'workflow/2' && version.executionMode === 'computation';
  const canActivate =
    detail.canManage &&
    version.compatible &&
    detail.connections.some((c) => !c.blockers.length);
  const done = async () => {
    setActivate(false);
    setMessage(m.workflows_detail_activated());
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
      setMessage(m.workflows_detail_revoked());
      await refresh();
    } catch (error) {
      setError(workflowError(error));
      if (error instanceof IdentityError && [401, 403].includes(error.status))
        await accessLost();
    } finally {
      setPending(false);
    }
  };
  const activation =
    !DomainControls && !computation ? (
      <Button
        disabled={!canActivate || refreshing}
        aria-describedby={
          !canActivate ? 'workflow-activation-reason' : undefined
        }
        onClick={() => setActivate(true)}
      >
        {m.workflows_detail_review_activation()}
      </Button>
    ) : null;

  return (
    <>
      <RecordHeader
        section={{
          label: m.workflows_title(),
          domain: 'workflows',
          link: (
            <Link
              to="/app/$organizationId/workflows"
              params={{ organizationId }}
              search={filters}
            />
          ),
        }}
        title={detail.summary.name}
      />
      <div className="workflow-action-bar">
        <ReadinessPills readiness={detail.summary.readiness} />
        <Button
          variant="ghost"
          aria-label={m.workflows_detail_refresh_label()}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} aria-hidden="true" /> {m.common_refresh()}
        </Button>
        <div className="workflow-version-controls">
          {detail.canManage &&
          !DomainControls &&
          version.format === 'workflow/2' ? (
            <EditWorkflowButton
              organizationId={organizationId}
              detail={detail}
              version={version.version}
            />
          ) : null}
          <Select
            aria-label={m.workflows_detail_version_label()}
            value={version.version}
            onValueChange={(value) => {
              if (value === null) return;
              setSelected(value);
              setActivate(false);
            }}
            options={detail.versions.map((v) => ({
              value: v.version,
              label:
                v.version === detail.summary.availableVersion
                  ? m.workflows_version_latest({ version: v.version })
                  : m.workflows_version_short({ version: v.version }),
            }))}
          />
        </div>
      </div>
      {message ? (
        <Alert tone="success" role="status" className="workflow-notice">
          {message}
        </Alert>
      ) : null}
      <SectionWorkspace
        label={m.workflows_detail_sections_label()}
        sections={[
          {
            value: 'overview',
            label: m.workflows_detail_tab_overview(),
            content: (
              <div id="overview" tabIndex={-1}>
                <WorkflowOverview
                  detail={detail}
                  version={version}
                  organizationId={organizationId}
                />
              </div>
            ),
          },
          {
            value: 'activity',
            label: m.workflows_detail_tab_activity(),
            content: (
              <div id="activity" tabIndex={-1} className="workflow-stack">
                {runs}
                {evaluation}
              </div>
            ),
          },
          {
            value: 'rules',
            label: m.workflows_detail_tab_rules(),
            content: (
              <div id="rules" tabIndex={-1} className="workflow-stack">
                {DomainControls ? (
                  <DomainControls
                    organizationId={organizationId}
                    detail={detail}
                    setup={setup}
                  />
                ) : (
                  <>
                    {activation && !canActivate ? (
                      <Alert
                        id="workflow-activation-reason"
                        tone={detail.canManage ? 'warning' : 'neutral'}
                        className="workflow-notice"
                      >
                        {!detail.canManage
                          ? m.workflows_detail_cannot_manage()
                          : !version.compatible
                            ? m.workflows_detail_incompatible()
                            : m.workflows_detail_no_connection()}
                      </Alert>
                    ) : null}
                    {!computation ? (
                      <WorkflowActivations
                        detail={detail}
                        refreshing={refreshing}
                        action={activation}
                        onRevoke={(item) => {
                          setRevoke(item);
                          setError('');
                        }}
                      />
                    ) : null}
                    <WorkflowTriggers
                      key={version.digest}
                      detail={detail}
                      version={version}
                      organizationId={organizationId}
                      refresh={refresh}
                      accessLost={accessLost}
                    />
                  </>
                )}
              </div>
            ),
          },
          {
            value: 'technical',
            label: m.workflows_detail_tab_technical(),
            content: (
              <div id="technical" tabIndex={-1}>
                <WorkflowTechnical
                  detail={detail}
                  version={version}
                  organizationId={organizationId}
                  code={
                    version.format === 'workflow/2' &&
                    version.codeSteps?.length ? (
                      <WorkflowCodeSteps
                        key={version.digest}
                        version={version}
                        organizationId={organizationId}
                        definitionId={detail.summary.id}
                        accessLost={accessLost}
                      />
                    ) : null
                  }
                />
              </div>
            ),
          },
        ]}
      />
      <Dialog open={activate && detail.canManage} onOpenChange={setActivate}>
        <DialogContent className="workflow-dialog">
          <DialogTitle>{m.workflows_detail_review_activation()}</DialogTitle>
          <DialogDescription>
            {m.workflows_detail_activation_description()}
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
          <DialogTitle>{m.workflows_detail_revoke_title()}</DialogTitle>
          <DialogDescription>
            {m.workflows_detail_revoke_description()}
          </DialogDescription>
          {revoke ? (
            <p>
              {m.workflows_detail_revoke_scope({
                version: revoke.version,
                count: revoke.grants.targetIds.length,
              })}
            </p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <div className="workflow-dialog-actions">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setRevoke(null)}
            >
              {m.common_cancel()}
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void revokeSelected()}
            >
              {pending
                ? m.workflows_detail_revoking()
                : m.workflows_detail_revoke_confirm()}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
