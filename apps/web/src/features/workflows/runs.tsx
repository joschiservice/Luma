import type {
  ActivityActor,
  WorkflowDetail,
  WorkflowRunView,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { ActionDiff } from '@luma/ui/components/issues/action-diff';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { CollectionViews } from '@luma/ui/components/primitives/collection-toolbar';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Empty } from '@luma/ui/components/primitives/empty';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { personLabel } from '@luma/ui/lib/actor';
import { Link, useLocation } from '@tanstack/react-router';
import { ChevronRight, History, ListFilter } from 'lucide-react';
import { type ComponentType, useState } from 'react';

import { CodeRunDetails } from './code-run';
import {
  inRunView,
  runOutcome,
  runSubjectLabel,
  type RunView,
  runViews,
  workflowTriggerLabel,
} from './presentation';
import { CancelScheduledStart } from './triggers';

type ProcessStep = NonNullable<WorkflowRunView['processSteps']>[number];

const stepStateLabels = {
  not_executed: m.issues_observe_only_title,
  completed: m.workflows_step_state_completed,
  waiting: m.workflows_step_state_waiting,
  denied: m.workflows_step_state_denied,
  failed: m.workflows_step_state_failed,
  inconclusive: m.workflows_step_state_inconclusive,
  ended: m.workflows_step_state_ended,
  escalated: m.workflows_step_state_escalated,
} satisfies Record<ProcessStep['state'], () => string>;

const evidenceLabels = {
  pilot: m.workflows_runs_source_pilot,
  live: m.workflows_runs_source_live,
  simulation: m.workflows_runs_source_simulation,
  shadow: m.workflows_runs_source_shadow,
  unclassified: m.workflows_runs_source_unclassified,
} satisfies Record<WorkflowRunView['evidenceKind'], () => string>;

function processStepDescription(step: ProcessStep) {
  if (step.reason === 'observe_only') return m.issues_observe_only_proposal();
  if (
    step.reason &&
    !['condition_not_met', 'policy_approval_required'].includes(step.reason)
  )
    return step.reason.replaceAll('_', ' ');

  switch (step.kind) {
    case 'code':
      return step.state === 'completed'
        ? m.workflows_step_code_completed()
        : step.state === 'waiting'
          ? m.workflows_step_code_waiting()
          : m.workflows_step_code_stopped();
    case 'read':
      return m.workflows_step_read();
    case 'condition':
      return step.values.matched
        ? m.workflows_step_condition_matched()
        : m.workflows_step_condition_not_matched();
    case 'approval':
      return step.state === 'waiting'
        ? m.workflows_step_approval_waiting()
        : m.workflows_step_approval_done();
    case 'capability':
      return step.state === 'waiting'
        ? m.workflows_step_change_waiting()
        : step.state === 'completed'
          ? m.workflows_step_change_accepted()
          : m.workflows_step_change_stopped();
    case 'wait':
      return step.state === 'waiting'
        ? m.workflows_step_wait_waiting()
        : m.workflows_step_wait_done();
    case 'verification':
      return step.state === 'completed'
        ? m.workflows_step_verify_confirmed()
        : step.state === 'failed'
          ? m.workflows_step_verify_failed()
          : m.workflows_step_verify_unclear();
    case 'escalation':
      return m.workflows_step_escalation();
    case 'end':
      return typeof step.values.outcome === 'string'
        ? step.values.outcome
        : m.workflows_step_end();
  }
}

/** Identifies the record a run worked on, so history can narrow to one record. */
const subjectKey = (run: WorkflowRunView) =>
  `${run.subject.kind}:${run.subject.id}`;

const runViewLabels = {
  all: m.workflows_runs_view_all,
  attention: m.workflows_runs_view_attention,
  active: m.workflows_runs_view_active,
  verified: m.workflows_runs_view_verified,
} satisfies Record<RunView, () => string>;

interface RunHistoryProps {
  detail: WorkflowDetail;
  organizationId: string;
  runs?: WorkflowRunView[] | undefined;
  /** The people who started the runs, or who an agent started them for. */
  people: readonly ActivityActor[];
  loading: boolean;
  error?: string | undefined;
  refreshing: boolean;
  refetch: () => void;
  refresh: () => Promise<void>;
  RunContext?:
    ComponentType<{ organizationId: string; run: WorkflowRunView }> | undefined;
}

/**
 * Lists recent runs as compact rows that open into their steps and evidence, with filters for
 * runs that need a look, are still in progress or were verified, and for one run's record. A
 * `#run-<id>` link opens that run in the full list. Acceptance and verification stay separate in
 * every row.
 */
export function WorkflowRuns({
  detail,
  organizationId,
  runs,
  people,
  loading,
  error,
  refreshing,
  refetch,
  refresh,
  RunContext,
}: RunHistoryProps) {
  const hash = useLocation({ select: (location) => location.hash });
  const linked = hash.startsWith('run-') ? hash.slice(4) : undefined;
  const [view, setView] = useState<RunView>('all');
  // Narrows history to one record's runs; the API returns the 50 most recent runs.
  const [subject, setSubject] = useState<string | null>(null);
  // Runs the reader opened or closed; others follow the defaults below.
  const [toggled, setToggled] = useState<Readonly<Record<string, boolean>>>({});
  // A newly linked run opens in the full list, even while another filter is chosen.
  const [shownLink, setShownLink] = useState(linked);
  if (linked !== shownLink) {
    setShownLink(linked);
    if (linked) {
      setToggled((previous) => ({ ...previous, [linked]: true }));
      setView('all');
      setSubject(null);
    }
  }
  const scoped =
    runs?.filter((run) => !subject || subjectKey(run) === subject) ?? [];
  const shown = scoped.filter((run) => inRunView(run, view));
  const subjectRun = subject ? scoped[0] : undefined;
  const sameSubject = (run: WorkflowRunView) =>
    runs?.filter((item) => subjectKey(item) === subjectKey(run)).length ?? 0;
  // A linked run opens, and so does a single run, which has nothing to compare against.
  const single = runs?.length === 1 ? runs[0]?.id : undefined;
  const isOpen = (id: string) =>
    toggled[id] ?? (id === linked || id === single);

  return (
    <section className="workflow-runs" aria-labelledby="runs-title">
      <div className="workflow-runs-head">
        <div>
          <h2 id="runs-title">{m.workflows_runs_title()}</h2>
          <p>
            {detail.versions.every((version) => version.format === 'workflow/2')
              ? m.workflows_runs_description_process()
              : m.workflows_runs_description_legacy()}
          </p>
        </div>
        <RefreshButton
          label={m.workflows_runs_refresh()}
          refreshing={refreshing}
          onClick={refetch}
        />
      </div>
      {runs?.length ? (
        <CollectionViews
          label={m.workflows_runs_views_label()}
          value={view}
          views={runViews.map((value) => ({
            value,
            label: runViewLabels[value](),
            count: scoped.filter((run) => inRunView(run, value)).length,
            attention: value === 'attention',
          }))}
          onChange={setView}
        />
      ) : null}
      {subjectRun ? (
        <Alert tone="neutral" role="status" className="workflow-runs-scope">
          <span>
            {m.workflows_runs_subject_scope({
              count: scoped.length,
              subject: subjectRun.resolution
                ? m.workflows_subject_issue()
                : runSubjectLabel(subjectRun.subject.kind),
            })}
          </span>
          <Button variant="outline" size="sm" onClick={() => setSubject(null)}>
            {m.workflows_runs_subject_clear()}
          </Button>
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {m.workflows_runs_error({ error })}
        </Alert>
      ) : null}
      {loading ? (
        <p role="status" className="workflow-runs-note">
          {m.workflows_runs_loading()}
        </p>
      ) : !runs?.length ? (
        error ? null : (
          <Empty className="workflow-section-empty">
            <History size={22} aria-hidden="true" />
            <h3>{m.workflows_runs_empty()}</h3>
            <p>
              {detail.summary.readiness.enablement === 'not_enabled'
                ? m.workflows_runs_empty_off()
                : m.workflows_runs_empty_on()}
            </p>
          </Empty>
        )
      ) : !shown.length ? (
        <p className="workflow-runs-note">
          {view === 'attention'
            ? m.workflows_runs_view_attention_empty()
            : m.workflows_runs_view_empty()}
        </p>
      ) : (
        <ol className="workflow-run-list" aria-label={m.workflows_runs_title()}>
          {shown.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              detail={detail}
              organizationId={organizationId}
              people={people}
              open={isOpen(run.id)}
              toggle={(next) =>
                setToggled((previous) => ({ ...previous, [run.id]: next }))
              }
              refresh={refresh}
              RunContext={RunContext}
              related={subject ? 0 : sameSubject(run)}
              showRelated={() => setSubject(subjectKey(run))}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/** One run: its state, record, trigger and time, opening into the full evidence. */
function RunRow({
  run,
  detail,
  organizationId,
  people,
  open,
  toggle,
  refresh,
  RunContext,
  related,
  showRelated,
}: {
  run: WorkflowRunView;
  detail: WorkflowDetail;
  organizationId: string;
  people: readonly ActivityActor[];
  open: boolean;
  toggle: (open: boolean) => void;
  refresh: () => Promise<void>;
  RunContext: RunHistoryProps['RunContext'];
  /** Recent runs for the same record, including this one; 0 hides the shortcut. */
  related: number;
  showRelated: () => void;
}) {
  const outcome = runOutcome(run);
  const body = `run-${run.id}-body`;
  const summary =
    run.processState === 'not_executed'
      ? m.issues_observe_only_proposal()
      : run.processSteps?.length || run.triggerState
        ? run.reason
        : run.story.verification;

  return (
    <li
      className="workflow-run"
      data-outcome={outcome.outcome}
      data-open={open || undefined}
    >
      <article
        id={`run-${run.id}`}
        tabIndex={-1}
        aria-labelledby={`${body}-title`}
      >
        <h3 className="workflow-run-heading">
          <button
            type="button"
            className="workflow-run-toggle"
            aria-expanded={open}
            aria-controls={body}
            onClick={() => toggle(!open)}
          >
            <ChevronRight
              className="workflow-run-chevron"
              size={15}
              aria-hidden="true"
            />
            <StatePill state={outcome.state}>{outcome.label}</StatePill>
            <span className="workflow-run-title" id={`${body}-title`}>
              <span>
                {run.resolution
                  ? m.workflows_subject_issue()
                  : runSubjectLabel(run.subject.kind)}
              </span>
              <span className="workflow-run-trigger">
                {workflowTriggerLabel(run.trigger)}
              </span>
            </span>
            <span className="workflow-run-meta">
              <span>{m.workflows_version_short({ version: run.version })}</span>
              <WorkspaceDate value={run.createdAt} />
            </span>
          </button>
        </h3>
        {summary && !open ? (
          <p className="workflow-run-summary">{summary}</p>
        ) : null}
        <div id={body} hidden={!open} className="workflow-run-body">
          {open ? (
            <RunBody
              run={run}
              detail={detail}
              organizationId={organizationId}
              people={people}
              // Story runs state their result again at the end of the body.
              summary={run.processSteps?.length ? summary : ''}
              refresh={refresh}
              RunContext={RunContext}
              related={related}
              showRelated={showRelated}
            />
          ) : null}
        </div>
      </article>
    </li>
  );
}

/** A run's record links, controls, step timeline or story, and provenance. */
function RunBody({
  run,
  detail,
  organizationId,
  people,
  summary,
  refresh,
  RunContext,
  related,
  showRelated,
}: {
  run: WorkflowRunView;
  detail: WorkflowDetail;
  organizationId: string;
  people: readonly ActivityActor[];
  summary: string;
  refresh: () => Promise<void>;
  RunContext: RunHistoryProps['RunContext'];
  related: number;
  showRelated: () => void;
}) {
  const here = useLocation({ select: (location) => location.href });
  const definitionId = detail.summary.id;
  const version = detail.versions.find(
    (item) => item.digest === run.versionDigest,
  );
  const stepTitle = (stepId: string) =>
    version?.steps.find((step) => step.id === stepId)?.title ??
    stepId.replaceAll(/[_-]/g, ' ');
  const cancellable =
    (run.triggerState === 'scheduled' ||
      (run.processState === 'waiting' &&
        ['human_task', 'event_wait'].includes(
          run.processSteps?.at(-1)?.kind ?? '',
        ))) &&
    detail.canManage;

  return (
    <>
      {run.triggerState ? (
        <Alert tone={run.triggerState === 'scheduled' ? 'neutral' : 'warning'}>
          {run.reason}
        </Alert>
      ) : summary ? (
        <p className="workflow-run-reason">{summary}</p>
      ) : null}
      <p className="workflow-run-links">
        {run.resolution ? (
          <Link
            to="/app/$organizationId/exceptions/$exceptionId"
            params={{
              organizationId,
              exceptionId: run.resolution.incidentId,
            }}
          >
            {m.workflows_runs_open_issue()}
          </Link>
        ) : run.subject.kind === 'inventory_position' ? (
          <Link
            to="/app/$organizationId/inventory/$positionId"
            params={{ organizationId, positionId: run.subject.id }}
            search={{ from: here }}
          >
            {m.workflows_runs_stock_position()}
          </Link>
        ) : null}
        {related > 1 ? (
          <Button variant="ghost" size="sm" onClick={showRelated}>
            <ListFilter aria-hidden="true" />
            {m.workflows_runs_subject_show({ count: related })}
          </Button>
        ) : null}
        <span>
          {rich(m.workflows_runs_version_source, {
            version: run.version,
            source: (
              <strong>
                {run.processSteps?.length
                  ? m.workflows_runs_source_process()
                  : evidenceLabels[run.evidenceKind]()}
              </strong>
            ),
          })}
        </span>
      </p>
      {cancellable ? (
        <CancelScheduledStart
          organizationId={organizationId}
          definitionId={definitionId}
          runId={run.id}
          refresh={refresh}
          coordination={run.processState === 'waiting'}
        />
      ) : null}
      {RunContext ? (
        <RunContext organizationId={organizationId} run={run} />
      ) : null}
      <CodeRunDetails
        run={run}
        version={version}
        organizationId={organizationId}
        definitionId={definitionId}
        canManage={detail.canManage}
        refresh={refresh}
      />
      {run.processSteps?.length ? (
        <ol
          className="workflow-process-timeline"
          aria-label={m.workflows_runs_steps_label()}
        >
          {run.processSteps.map((step) => (
            <li key={`${step.stepId}:${step.state}`}>
              <span
                className={`workflow-process-dot workflow-process-dot--${step.state}`}
                aria-hidden="true"
              />
              <div>
                <div className="workflow-process-step-heading">
                  <strong>{stepTitle(step.stepId)}</strong>
                  <span>{stepStateLabels[step.state]()}</span>
                  <WorkspaceDate value={step.recordedAt} />
                </div>
                <p>{processStepDescription(step)}</p>
                {run.actionReviews
                  ?.filter((review) => review.stepId === step.stepId)
                  .map((review) => (
                    <ActionDiff key={review.stepId} diff={review.diff} />
                  ))}
                {step.evidenceRefs.length ? (
                  <p>
                    {m.workflows_runs_evidence_count({
                      count: step.evidenceRefs.length,
                    })}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <>
          <dl className="workflow-run-story">
            <div>
              <dt>{m.workflows_runs_story_context()}</dt>
              <dd>{run.story.context}</dd>
            </div>
            <div>
              <dt>{m.workflows_runs_story_decision()}</dt>
              <dd>{run.story.decision}</dd>
            </div>
            <div>
              <dt>{m.workflows_runs_story_action()}</dt>
              <dd>{run.story.action}</dd>
            </div>
          </dl>
          <dl className="workflow-run-checks">
            <div>
              <dt>{m.workflows_runs_change_status()}</dt>
              <dd>{run.execution.replaceAll('_', ' ')}</dd>
            </div>
            <div>
              <dt>{m.workflows_runs_check_status()}</dt>
              <dd>{run.verification.replaceAll('_', ' ')}</dd>
            </div>
          </dl>
          <p className="workflow-run-result">{run.story.verification}</p>
        </>
      )}
      <Disclosure>
        <summary>{m.workflows_runs_details()}</summary>
        <p>{m.workflows_runs_id({ id: run.id })}</p>
        <p>
          {run.activationId
            ? m.workflows_runs_activation({ id: run.activationId })
            : m.workflows_runs_activation_none()}
        </p>
        {run.triggerEvidence ? (
          <p>
            {rich(m.workflows_runs_source, {
              source: run.triggerEvidence.sourceId,
              date: <WorkspaceDate value={run.triggerEvidence.occurredAt} />,
            })}
          </p>
        ) : null}
        <p>
          {run.actor.kind === 'agent'
            ? m.workflows_runs_started_by_agent({
                agent: run.actor.id,
                person: personLabel(people, run.actor.operatorId),
              })
            : m.workflows_runs_started_by({
                actor: personLabel(people, run.actor.id),
              })}
        </p>
        <p>
          {m.workflows_runs_record({
            kind: run.subject.kind,
            id: run.subject.id,
          })}
        </p>
        <p>
          {m.workflows_runs_trigger({
            trigger:
              run.trigger.kind === 'exception'
                ? run.trigger.issueType.replaceAll('_', ' ')
                : run.trigger.kind,
          })}
        </p>
        <p>
          {m.workflows_runs_input_fingerprint()}{' '}
          <code>{run.contextDigest}</code>
        </p>
        {run.steps.length ? (
          <ol>
            {run.steps.map((step, index) => (
              <li key={`${step.stepId}:${index}`}>
                {step.stepId} · {step.state.replaceAll('_', ' ')} ·{' '}
                {step.reason.replaceAll('_', ' ')}
              </li>
            ))}
          </ol>
        ) : !run.processSteps?.length ? (
          <p>{m.workflows_runs_no_steps()}</p>
        ) : null}
        {run.processSteps?.length ? (
          <ol>
            {run.processSteps.map((step) => (
              <li key={`${step.stepId}:${step.state}`}>
                {step.stepId} · {step.kind} · {step.state}
                {step.evidenceRefs.length
                  ? ` · ${step.evidenceRefs.join(', ')}`
                  : ''}
              </li>
            ))}
          </ol>
        ) : null}
        <code>{run.versionDigest}</code>
      </Disclosure>
    </>
  );
}
