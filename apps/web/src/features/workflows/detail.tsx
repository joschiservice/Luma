import './workflows.css';

import type {
  WorkflowActivationView,
  WorkflowDetail,
  WorkflowReadiness,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { Select } from '@luma/ui/components/primitives/select';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@luma/ui/components/primitives/tabs';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import {
  type RecordFact,
  RecordHeader,
} from '@luma/ui/components/workspace/record-header';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useLocation,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  CircleCheck,
  Clock3,
  Play,
  ShieldCheck,
  Target,
  UserCheck,
  Zap,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { SignInRedirect } from '../../kit/identity/common';
import { contextOptions, IdentityError } from '../../kit/identity/data';
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
  successDefinition,
  WorkflowActivations,
  WorkflowOverview,
  WorkflowTechnical,
} from './detail-sections';
import { workflowDomainView } from './domain-views';
import { type WorkflowFilters, WorkflowLoading } from './library';
import { OfflineNotice } from './offline';
import { inRunView, workflowTriggerLabel } from './presentation';
import {
  coverageLabel,
  hasNextStep,
  ReadinessPills,
  WorkflowNextStep,
} from './readiness';
import { WorkflowRuns } from './runs';
import { ShadowReport } from './shadow/report';
import { WorkflowTriggers } from './triggers';

/**
 * The detail page's tabs. Their values are the URL hashes other pages already link to, so
 * `#rules` opens setup and `#activity` opens runs.
 */
type WorkflowTab = 'activity' | 'overview' | 'rules' | 'technical';

/**
 * A workflow that is on opens on its runs. One that is off explains how it works, unless setting
 * it up happens in its own controls, such as stock rules, rather than in the page header.
 */
function defaultTab(detail: WorkflowDetail): WorkflowTab {
  if (detail.summary.readiness.enablement !== 'not_enabled') return 'activity';
  const domainView = workflowDomainView(detail);

  return domainView && !domainView.Action ? 'rules' : 'overview';
}

/**
 * Picks the tab a URL hash names; anchors inside a tab, such as `run-<id>`, the test results
 * report or a replenishment `rule-<id>`, open the tab that holds them. Without a hash, `fallback` applies.
 */
function workflowTab(
  hash: string,
  fallback: WorkflowTab,
  setup?: string,
): WorkflowTab {
  if (
    hash === 'activity' ||
    hash === 'shadow-report' ||
    hash.startsWith('run-')
  )
    return 'activity';
  if (hash === 'rules' || hash.startsWith('rule-') || setup) return 'rules';
  if (hash === 'overview' || hash === 'technical') return hash;

  return fallback;
}

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
 * Scrolls to and focuses the element named by the URL hash, such as `run-<id>`, once it has
 * rendered. Tab hashes name no element, so switching tabs keeps the scroll position.
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
function WorkflowDetailPage({
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
  const hash = useLocation({ select: (location) => location.hash });
  // The default tab follows the workflow as first loaded, so turning it on doesn't move the reader.
  const [fallback, setFallback] = useState<WorkflowTab>();
  const tab = fallback ? workflowTab(hash, fallback, setup) : undefined;
  // While runs are on screen, the status and facts above them follow at a slower pace.
  const query = useQuery({
    ...workflowOptions(organizationId, definitionId),
    refetchInterval: tab === 'activity' ? 30000 : false,
  });
  if (query.data && !fallback) setFallback(defaultTab(query.data));
  // Runs refresh quickly while they're on screen; the tab count follows at a slower pace.
  const runs = useQuery({
    ...workflowRunsOptions(organizationId, definitionId),
    refetchInterval: tab === 'activity' ? 5000 : 30000,
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
    <div className="workflows-page workflow-detail-page">
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
          tab={tab}
          refresh={refresh}
          refreshing={query.isFetching || !!query.error}
          accessLost={accessLost}
          runCount={runs.data?.items.length}
          runsNeedLook={
            runs.data?.items.some((run) => inRunView(run, 'attention')) ?? false
          }
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
              runs={runs.data?.items}
              people={runs.data?.people ?? []}
              loading={runs.isPending}
              error={runs.error ? workflowError(runs.error) : undefined}
              refreshing={runs.isFetching}
              refetch={() => void refresh()}
              refresh={refresh}
              RunContext={domainView?.RunContext}
            />
          }
        />
      ) : null}
    </div>
  );
}

const approvalModes = {
  every_action: m.workflows_readiness_approval_every,
  risk_based: m.workflows_readiness_approval_risk,
  no_actions: m.workflows_readiness_approval_none,
} satisfies Record<WorkflowReadiness['approval']['mode'], () => string>;

/** Summarizes recent results so that only independently verified runs read as verified. */
function resultsLabel(outcomes: WorkflowReadiness['outcomes']) {
  if (!outcomes) return m.workflows_outcomes_not_tracked();
  if (!outcomes.runs) return m.workflows_outcomes_no_runs();

  return [
    m.workflows_outcomes_verified({ count: outcomes.verified }),
    ...(outcomes.unresolved
      ? [m.workflows_outcomes_unresolved({ count: outcomes.unresolved })]
      : []),
    ...(outcomes.inProgress
      ? [m.workflows_outcomes_in_progress({ count: outcomes.inProgress })]
      : []),
  ].join(' · ');
}

/**
 * Presents one workflow: its status, purpose and key facts, the next step when one is needed,
 * the controls that turn it on, then tabs for runs, how it works, setup and details. The header
 * and next step stay visible on every tab.
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
  runCount,
  runsNeedLook = false,
  tab: shownTab,
}: {
  detail: WorkflowDetail;
  /** The open tab; without it the URL hash and the workflow's state decide. */
  tab?: WorkflowTab | undefined;
  filters?: WorkflowFilters;
  /** A stock position to preselect in stock-rule setup. */
  setup?: string | undefined;
  evaluation?: ReactNode;
  runs?: ReactNode;
  /** Recent runs, once loaded, for the Runs tab. */
  runCount?: number | undefined;
  /** Whether a recent run failed, needs review or waits for a person. */
  runsNeedLook?: boolean;
  organizationId: string;
  refresh: () => Promise<void>;
  refreshing?: boolean;
  accessLost: () => Promise<void>;
}) {
  const hash = useLocation({ select: (location) => location.hash });
  const readiness = detail.summary.readiness;
  const tab = shownTab ?? workflowTab(hash, defaultTab(detail), setup);
  const domainView = workflowDomainView(detail);
  const DomainControls = domainView?.Controls;
  const DomainAction = domainView?.Action;
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
  const activationReason = !detail.canManage
    ? m.workflows_detail_cannot_manage()
    : !version.compatible
      ? m.workflows_detail_incompatible()
      : m.workflows_detail_no_connection();
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
        title={!canActivate ? activationReason : undefined}
        aria-describedby={
          !canActivate && tab === 'rules'
            ? 'workflow-activation-reason'
            : undefined
        }
        onClick={() => setActivate(true)}
      >
        <ShieldCheck aria-hidden="true" />
        {m.workflows_detail_review_activation()}
      </Button>
    ) : null;
  const tabLink = (value: WorkflowTab) => (
    <Link
      to="/app/$organizationId/workflows/$definitionId"
      params={{ organizationId, definitionId: detail.summary.id }}
      search={(previous) => previous}
      hash={value}
      replace
      resetScroll={false}
    />
  );
  const startRun =
    !DomainControls &&
    detail.canManage &&
    version.format !== 'resolution-playbook/0' &&
    version.applicability.trigger.kind !== 'exception' &&
    version.applicability.trigger.kind !== 'schedule' &&
    tab !== 'rules' ? (
      <Link
        className={buttonVariants({
          variant: activation ? 'outline' : 'default',
        })}
        to="/app/$organizationId/workflows/$definitionId"
        params={{ organizationId, definitionId: detail.summary.id }}
        search={(previous) => previous}
        hash="rules"
        resetScroll={false}
      >
        <Play aria-hidden="true" />
        {m.workflows_detail_start_run()}
      </Link>
    ) : null;
  const latest = readiness.outcomes?.latest;
  const facts: RecordFact[] = [
    {
      key: 'trigger',
      icon: Zap,
      label: m.workflows_overview_when(),
      value: workflowTriggerLabel(version.applicability.trigger),
    },
    {
      key: 'success',
      icon: ShieldCheck,
      label: m.workflows_overview_success(),
      value: successDefinition(version),
    },
    {
      key: 'approval',
      icon: UserCheck,
      label: m.workflows_readiness_approval(),
      value: approvalModes[readiness.approval.mode](),
    },
    {
      key: 'coverage',
      icon: Target,
      label: m.workflows_readiness_covers(),
      value: coverageLabel(readiness.coverage),
      tone:
        readiness.coverage.ready !== null &&
        readiness.coverage.covered !== null &&
        readiness.coverage.ready < readiness.coverage.covered
          ? 'warning'
          : undefined,
    },
    {
      key: 'results',
      icon: CircleCheck,
      label: m.workflows_readiness_results(),
      value: resultsLabel(readiness.outcomes),
      tone: readiness.outcomes?.unresolved ? 'warning' : undefined,
    },
    {
      key: 'latest',
      icon: Clock3,
      label: m.workflows_detail_last_run(),
      value: latest ? (
        <WorkspaceDate value={latest.at} />
      ) : (
        m.workflows_detail_never_run()
      ),
    },
  ];

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
        actions={
          <>
            <RefreshButton
              label={m.workflows_detail_refresh_label()}
              refreshing={refreshing ?? false}
              onClick={() => void refresh()}
            />
            {detail.versions.length > 1 ? (
              <Select
                aria-label={m.workflows_detail_version_label()}
                className="workflow-version-select"
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
            ) : null}
            {detail.canManage &&
            !DomainControls &&
            version.format === 'workflow/2' ? (
              <EditWorkflowButton
                organizationId={organizationId}
                detail={detail}
                version={version.version}
              />
            ) : null}
            {startRun}
            {activation}
            {DomainAction ? (
              <DomainAction
                organizationId={organizationId}
                detail={detail}
                notify={setMessage}
              />
            ) : null}
          </>
        }
        status={
          <>
            <ReadinessPills readiness={readiness} />
            <span className="workflow-detail-meta">
              {detail.versions.length > 1 &&
              version.version !== detail.summary.availableVersion
                ? m.workflows_detail_viewing_version({
                    version: version.version,
                  })
                : m.workflows_version_short({ version: version.version })}
            </span>
            <div className="workflow-detail-purpose">
              <p>{detail.summary.purpose}</p>
            </div>
          </>
        }
        facts={facts}
      />
      {message ? (
        <Alert tone="success" role="status" className="workflow-notice">
          {message}
        </Alert>
      ) : null}
      {hasNextStep(readiness) ? (
        <WorkflowNextStep
          organizationId={organizationId}
          definitionId={detail.summary.id}
          readiness={readiness}
          setupInHeader={!!(DomainAction ?? activation ?? startRun)}
        />
      ) : null}
      <Tabs value={tab} className="workflow-tabs">
        <TabsList
          variant="line"
          aria-label={m.workflows_detail_sections_label()}
          activateOnFocus={false}
          className="workflow-tab-list"
        >
          <TabsTrigger
            value="activity"
            nativeButton={false}
            render={tabLink('activity')}
          >
            {m.workflows_detail_tab_runs()}
            {runCount !== undefined ? (
              <Badge tone={runsNeedLook ? 'warning' : 'neutral'}>
                {formatNumber(runCount)}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger
            value="overview"
            nativeButton={false}
            render={tabLink('overview')}
          >
            {m.workflows_detail_tab_overview()}
          </TabsTrigger>
          <TabsTrigger
            value="rules"
            nativeButton={false}
            render={tabLink('rules')}
          >
            {domainView?.setupLabel?.() ?? m.workflows_detail_tab_rules()}
          </TabsTrigger>
          <TabsTrigger
            value="technical"
            nativeButton={false}
            render={tabLink('technical')}
          >
            {m.workflows_detail_tab_technical()}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="activity" className="workflow-tab-panel">
          <div className="workflow-stack">
            {runs}
            {evaluation}
          </div>
        </TabsContent>
        <TabsContent value="overview" className="workflow-tab-panel">
          <WorkflowOverview detail={detail} version={version} />
        </TabsContent>
        <TabsContent value="rules" className="workflow-tab-panel">
          <div className="workflow-stack">
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
                    {activationReason}
                  </Alert>
                ) : null}
                {!computation ? (
                  <WorkflowActivations
                    detail={detail}
                    refreshing={refreshing}
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
        </TabsContent>
        <TabsContent value="technical" className="workflow-tab-panel">
          <WorkflowTechnical
            detail={detail}
            version={version}
            organizationId={organizationId}
            code={
              version.format === 'workflow/2' && version.codeSteps?.length ? (
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
        </TabsContent>
      </Tabs>
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
