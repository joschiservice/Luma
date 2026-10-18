import type {
  CaseDetail,
  CaseProgress,
  CaseReview,
  CaseSummary,
  Diagnosis,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import {
  Activity,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  FileText,
  ListChecks,
  RefreshCw,
  ShieldQuestion,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { operatorCodeMessages } from '../../lib/operator-code';
import { Alert, AlertDescription, AlertTitle } from '../primitives/alert';
import { Badge } from '../primitives/badge';
import { Button } from '../primitives/button';
import { Disclosure } from '../primitives/disclosure';
import { WorkspaceDate } from '../primitives/workspace-date';
import {
  caseStateLabel,
  caseSummaryText,
  freshnessLabel,
  quantityLabel,
  severityFullLabel,
  unitLabel,
} from './case-presentation';
import { IssueCollection } from './issue-collection';
import { IssueContext } from './issue-context';
import {
  EvidenceRecord,
  evidenceSourceLabel,
  IssueFindings,
} from './issue-findings';
import { IssueOverview } from './issue-overview';
import { IssueRecordDetails } from './issue-record-details';
import { IssueSection } from './issue-section';

/**
 * Converts an underscore-separated code that has no translated label into readable text, such
 * as `inventory_position` → “Inventory position”. Prefer a named label where one exists.
 */
export function caseLabel(value: string) {
  return (
    operatorCodeMessages[value]?.() ??
    value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())
  );
}

/** Renders a case timestamp in the workspace display timezone. */
export function CaseTime({ value }: { value: string }) {
  return <WorkspaceDate value={value} />;
}

function issueStateLabel(item: CaseSummary): string | null {
  if (item.state === 'resolved')
    return item.resolution === 'verified'
      ? m.issues_status_verified()
      : m.issues_status_closed();
  if (item.state === 'detected') return null;

  return item.state === 'escalated'
    ? m.issues_status_needs_review()
    : caseStateLabel(item.state);
}

const diagnosisStatuses = {
  pending: m.issues_diagnosis_pending,
  ready: m.issues_diagnosis_ready,
  insufficient_evidence: m.issues_status_needs_evidence,
  failed: m.issues_diagnosis_failed,
} satisfies Record<Diagnosis['status'], () => string>;

/** Displays the recorded issue state and severity. */
function CaseStatus({ item }: { item: CaseSummary }) {
  return (
    <div className="case-badges">
      <Badge tone={item.severity === 'high' ? 'warning' : 'neutral'}>
        {severityFullLabel(item.severity)}
      </Badge>
      {issueStateLabel(item) && <Badge>{issueStateLabel(item)}</Badge>}
    </div>
  );
}

/** Renders a titled status message, or an alert when error is set. */
export function CaseNotice({
  title,
  children,
  error = false,
}: {
  title: string;
  children?: ReactNode;
  error?: boolean;
}) {
  return (
    <Alert
      className="case-notice"
      tone={error ? 'danger' : 'neutral'}
      role={error ? 'alert' : 'status'}
    >
      <AlertTitle>{title}</AlertTitle>
      {children ? <AlertDescription>{children}</AlertDescription> : null}
    </Alert>
  );
}

/** Announces that a case investigation is loading. */
export function CaseLoading() {
  return (
    <div
      className="case-loading"
      role="status"
      aria-label={m.issues_loading_issues()}
    >
      <span />
      <span />
      <span />
      <span />
      <p>{m.issues_loading_issues()}</p>
    </div>
  );
}

function EvidenceReferences({ refs }: { refs: string[] }) {
  return (
    <Disclosure className="finding-sources">
      <summary>{m.issues_evidence_references({ count: refs.length })}</summary>
      <ul>
        {refs.map((ref) => (
          <li key={ref}>
            <code>{ref}</code>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

function Findings({ items }: { items: Diagnosis['facts'] }) {
  return (
    <ul className="case-findings">
      {items.map((item) => (
        <li key={item.code}>
          <p>{item.text}</p>
          {item.evidenceRefs.length ? (
            <EvidenceReferences refs={item.evidenceRefs} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Exposure({ diagnosis, note }: { diagnosis: Diagnosis; note: string }) {
  const quantity = diagnosis.impact.exposedQuantity!;

  return (
    <>
      <div>
        <span>{m.issues_exposure_label()}</span>
        <p>{note}</p>
      </div>
      <strong>
        {quantityLabel(quantity)}{' '}
        {diagnosis.impact.unit ? (
          <small>{unitLabel(diagnosis.impact.unit, quantity)}</small>
        ) : null}
      </strong>
    </>
  );
}

/** Explains why the current findings can’t be acted on yet: unconfirmed, out of date, pending or incomplete. */
function InvestigationNotices({
  item,
  unconfirmed,
}: {
  item: CaseDetail;
  unconfirmed: boolean;
}) {
  if (item.state === 'resolved')
    return unconfirmed ? (
      <CaseNotice title={m.issues_notice_unconfirmed_title()}>
        {m.issues_notice_unconfirmed_body()}
      </CaseNotice>
    ) : null;

  return (
    <>
      {unconfirmed ? (
        <CaseNotice title={m.issues_notice_unconfirmed_title()}>
          {m.issues_notice_unconfirmed_body()}
        </CaseNotice>
      ) : null}
      {item.freshness === 'stale' ? (
        <CaseNotice title={m.issues_notice_stale_title()}>
          {m.issues_notice_stale_body()}
        </CaseNotice>
      ) : null}
      {item.diagnosisStatus === 'pending' ? (
        <CaseNotice title={m.issues_notice_pending_title()}>
          {m.issues_notice_pending_body()}
        </CaseNotice>
      ) : null}
      {item.diagnosisStatus === 'failed' ? (
        <CaseNotice title={m.issues_notice_failed_title()}>
          {m.issues_notice_failed_body()}
        </CaseNotice>
      ) : null}
      {item.diagnosisStatus === 'insufficient_evidence' &&
      item.freshness !== 'stale' ? (
        <CaseNotice title={m.issues_notice_insufficient_title()}>
          {m.issues_notice_insufficient_body()}
        </CaseNotice>
      ) : null}
    </>
  );
}

function FindingsSummary({ item }: { item: CaseDetail }) {
  return (
    <span>
      {m.issues_findings_and_evidence()}
      <small>
        {m.issues_findings_and_evidence_count({
          findings: item.diagnosis?.facts.length ?? 0,
          evidence: item.diagnosis?.provenance.evidence.length ?? 0,
        })}
      </small>
    </span>
  );
}

function ActivitySummary({ item }: { item: CaseDetail }) {
  return (
    <span>
      {m.issues_activity_and_history()}
      <small>
        {rich(m.issues_activity_summary, {
          state: issueStateLabel(item) ?? m.issues_activity_open(),
          time: <CaseTime value={item.lastActivityAt} />,
        })}
      </small>
    </span>
  );
}

type InvestigationProps = {
  expanded?: boolean;
  embedded?: boolean;
  item: CaseDetail;
  progress?: ReactNode;
  review?: CaseReview;
  lifecycle?: CaseProgress;
  unconfirmed?: boolean;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean;
};

/**
 * Presents investigation status, findings, and next steps without initiating execution.
 * Expanded pages open findings and display record metadata in their own surrounding layout.
 */
export function CaseInvestigation(props: InvestigationProps) {
  if (
    props.item.diagnosisStatus === 'failed' &&
    props.item.state !== 'resolved'
  )
    return <FailedInvestigation {...props} />;

  return <InvestigationReport {...props} />;
}

function FailedInvestigation({
  item,
  progress,
  unconfirmed = false,
  onRefresh,
  refreshing = false,
  embedded = false,
  expanded = false,
}: InvestigationProps) {
  const diagnosis = item.diagnosis;
  const historical =
    item.freshness === 'stale' ||
    diagnosis?.superseded ||
    item.state === 'resolved';

  return (
    <article
      className="failed-investigation"
      aria-label={m.issues_investigation_label()}
    >
      {!embedded && (
        <header className="failed-investigation-header">
          <div className="failed-investigation-context">
            <span className="failed-priority">
              {severityFullLabel(item.severity)}
            </span>
          </div>
          <h2>{caseSummaryText(item.summary).replace(/\.+$/, '')}</h2>
          <IssueContext item={item} />
        </header>
      )}
      <IssueSection section="overview" enabled={expanded}>
        <section
          className="investigation-failure"
          aria-label={m.issues_investigation_status()}
        >
          <CircleAlert size={22} aria-hidden="true" />
          <div>
            <h3>{m.issues_status_investigation_failed()}</h3>
            <p>{m.issues_investigation_failed_body()}</p>
          </div>
        </section>
        {unconfirmed || historical ? (
          <div className="failed-context-warning" role="status">
            <ShieldQuestion size={18} aria-hidden="true" />
            <p>
              {unconfirmed
                ? m.issues_investigation_unconfirmed_warning()
                : m.issues_investigation_historical_warning()}
            </p>
          </div>
        ) : null}
        <section className="failed-next-step" aria-label={m.issues_next_step()}>
          <h3>
            <RefreshCw size={16} aria-hidden="true" />
            {m.issues_next_step()}
          </h3>
          <div className="failed-update-action">
            <p>{m.issues_investigation_check_updates_hint()}</p>
            {onRefresh ? (
              <Button
                variant="outline"
                onClick={onRefresh}
                disabled={refreshing}
              >
                <RefreshCw aria-hidden="true" />
                {refreshing
                  ? m.issues_investigation_checking()
                  : m.issues_investigation_check_updates()}
              </Button>
            ) : null}
          </div>
          <p className="failed-help">
            {onRefresh
              ? m.issues_investigation_check_updates_help()
              : m.issues_investigation_refresh_help()}
          </p>
          {item.attention.required && (
            <div className="failed-review-request">
              <CircleAlert size={16} aria-hidden="true" />
              <div>
                <strong>{m.issues_investigation_review_requested()}</strong>
                <p>{item.attention.explanation}</p>
              </div>
            </div>
          )}
        </section>
        <section
          className="failed-recorded-context"
          aria-label={m.issues_investigation_recorded()}
        >
          <div className="failed-context-heading">
            <h3>
              <FileText size={16} aria-hidden="true" />
              {m.issues_investigation_recorded()}
            </h3>
            <span className="failed-freshness">
              {unconfirmed
                ? m.issues_evidence_badge_unconfirmed()
                : historical
                  ? m.issues_evidence_badge_historical()
                  : item.freshness === 'fresh'
                    ? m.issues_evidence_badge_fresh()
                    : m.issues_evidence_badge_unknown()}
            </span>
          </div>
          {diagnosis?.impact.exposedQuantity != null ? (
            <div className="failed-exposure">
              <Exposure
                diagnosis={diagnosis}
                note={m.issues_exposure_note_before_finish()}
              />
            </div>
          ) : (
            <p className="failed-help">
              {diagnosis?.facts.length
                ? m.issues_investigation_impact_unknown()
                : m.issues_investigation_no_findings()}
            </p>
          )}
        </section>
      </IssueSection>
      {expanded ? (
        <IssueSection
          section="findings"
          preview={
            diagnosis?.facts.length
              ? m.issues_findings_fact_count({ count: diagnosis.facts.length })
              : m.issues_findings_fact_count_none()
          }
        >
          <IssueFindings item={item} unconfirmed={unconfirmed} />
        </IssueSection>
      ) : (
        <Disclosure
          className="failed-disclosure"
          data-issue-section="findings"
          open={expanded}
        >
          <summary>
            <FileText size={18} aria-hidden="true" />
            <FindingsSummary item={item} />
            <ChevronRight size={16} aria-hidden="true" />
          </summary>
          <div className="failed-disclosure-content">
            <InvestigationReport
              item={item}
              unconfirmed={unconfirmed}
              hideHeader
              recordedOnly
              progress={<></>}
            />
          </div>
        </Disclosure>
      )}
      {expanded ? (
        (progress ?? (
          <IssueSection section="execution">
            <p>{m.issues_activity_none()}</p>
          </IssueSection>
        ))
      ) : (
        <Disclosure
          className="failed-disclosure"
          data-issue-section="execution"
          open={expanded}
        >
          <summary>
            <Activity size={18} aria-hidden="true" />
            <ActivitySummary item={item} />
            <ChevronRight size={16} aria-hidden="true" />
          </summary>
          <div className="failed-disclosure-content">
            {progress ?? (
              <>
                <p>
                  {item.resolution === 'verified'
                    ? m.issues_resolution_verified_body()
                    : item.resolution === 'human_disposition'
                      ? m.issues_resolution_human_body()
                      : m.issues_resolution_open()}
                </p>
                <p className="failed-recorded-time">
                  <Clock3 size={16} aria-hidden="true" />
                  {rich(m.issues_detected_at, {
                    time: <CaseTime value={item.detectedAt} />,
                  })}
                </p>
              </>
            )}
          </div>
        </Disclosure>
      )}
      {!expanded && <IssueRecordDetails key={item.id} item={item} />}
    </article>
  );
}

function InvestigationReport({
  item,
  progress,
  review,
  lifecycle,
  unconfirmed = false,
  hideHeader = false,
  recordedOnly = false,
  embedded = false,
  expanded = false,
}: {
  item: CaseDetail;
  progress?: ReactNode;
  review?: CaseReview;
  lifecycle?: CaseProgress;
  unconfirmed?: boolean;
  hideHeader?: boolean;
  recordedOnly?: boolean;
  embedded?: boolean;
  expanded?: boolean;
}) {
  const diagnosis = item.diagnosis;
  const historical =
    diagnosis?.superseded ||
    item.freshness === 'stale' ||
    item.state === 'resolved';

  return (
    <article
      className="case-investigation recorded-findings"
      aria-label={m.issues_investigation_label()}
    >
      {!hideHeader && !embedded && (
        <header>
          <CaseStatus item={item} />
          <h2>{caseSummaryText(item.summary).replace(/\.+$/, '')}</h2>
          <IssueContext item={item} />
        </header>
      )}
      {!hideHeader && embedded && !expanded && item.state !== 'detected' && (
        <div className="case-badges">
          <Badge>{issueStateLabel(item)}</Badge>
        </div>
      )}
      {recordedOnly ? (
        <>
          <section>
            <h3>
              <Activity size={16} aria-hidden="true" />{' '}
              {m.issues_impact_title()}
            </h3>
            {diagnosis?.impact.observed.length ? (
              <>
                <h4>{m.issues_findings_confirmed_impact()}</h4>
                <Findings items={diagnosis.impact.observed} />
              </>
            ) : null}
            {diagnosis?.impact.potential.length ? (
              <>
                <h4>{m.issues_findings_potential_impact()}</h4>
                <Findings items={diagnosis.impact.potential} />
              </>
            ) : null}
            {!diagnosis?.impact.observed.length &&
            !diagnosis?.impact.potential.length ? (
              <p>{m.issues_impact_unknown()}</p>
            ) : null}
            <p className="case-caption">{m.issues_impact_revenue_unknown()}</p>
          </section>
          <section>
            <h3>
              <ListChecks size={16} aria-hidden="true" />{' '}
              {m.issues_findings_title()}
            </h3>
            {historical ? (
              <p className="case-caption">{m.issues_findings_historical()}</p>
            ) : null}
            <h4>{m.issues_findings_confirmed_facts()}</h4>
            {diagnosis?.facts.length ? (
              <Findings items={diagnosis.facts} />
            ) : (
              <p>{m.issues_findings_none()}</p>
            )}
            {diagnosis?.constraints.length ? (
              <>
                <h4 className="findings-uncertainty-heading">
                  <ShieldQuestion size={14} aria-hidden="true" />{' '}
                  {m.issues_findings_uncertain()}
                </h4>
                <ul className="findings-constraints">
                  {diagnosis.constraints.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {diagnosis?.hypotheses.length ? (
              <Disclosure className="case-hypotheses">
                <summary>
                  <ShieldQuestion size={16} aria-hidden="true" />
                  <span>{m.issues_findings_causes_and_checks()}</span>
                  <span className="hypothesis-count">
                    {diagnosis.hypotheses.length}
                  </span>
                  <ChevronRight size={14} aria-hidden="true" />
                </summary>
                {diagnosis.hypotheses.map((h) => (
                  <div className="hypothesis-item" key={h.code}>
                    <span className="hypothesis-status">
                      {m.issues_findings_unconfirmed_label()}
                    </span>
                    <p className="hypothesis-text">{h.text}</p>
                    {h.missingChecks.length > 0 && (
                      <div className="hypothesis-checks">
                        <h4>{m.issues_findings_checks_needed()}</h4>
                        <ul>
                          {h.missingChecks.map((text) => (
                            <li key={text}>
                              <ListChecks size={14} aria-hidden="true" />
                              <span>{text}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {h.evidenceRefs.length > 0 && (
                      <EvidenceReferences refs={h.evidenceRefs} />
                    )}
                  </div>
                ))}
              </Disclosure>
            ) : null}
          </section>
          <section>
            <h3>
              <Database size={16} aria-hidden="true" />{' '}
              {m.issues_evidence_supporting_title()}
            </h3>
            <p className="case-caption">
              {m.issues_evidence_freshness({
                freshness: freshnessLabel(item.freshness),
              })}
            </p>
            <IssueCollection
              title={m.issues_evidence_supporting_title()}
              noun="evidence"
              items={[...(diagnosis?.provenance.evidence ?? [])].sort((a, b) =>
                b.observedAt.localeCompare(a.observedAt),
              )}
              filters={[
                { label: m.common_source(), value: evidenceSourceLabel },
              ]}
              renderItems={(entries) =>
                entries.length ? (
                  entries.map((e) => <EvidenceRecord key={e.id} entry={e} />)
                ) : (
                  <p>{m.issues_evidence_none()}</p>
                )
              }
            />
            {diagnosis?.provenance.mappingVersions.length ? (
              <p className="case-caption">
                {m.issues_findings_link_versions_value({
                  versions: diagnosis.provenance.mappingVersions.join(', '),
                })}
              </p>
            ) : null}
            {diagnosis ? (
              <p className="case-caption">
                {m.issues_findings_configuration_value({
                  configuration: diagnosis.provenance.configVersion,
                  rules: diagnosis.provenance.ruleVersion,
                })}
              </p>
            ) : null}
          </section>
        </>
      ) : (
        <>
          <IssueSection section="overview" enabled={expanded}>
            {expanded ? (
              <IssueOverview
                item={item}
                unconfirmed={unconfirmed}
                review={review}
                lifecycle={lifecycle}
              >
                <InvestigationNotices item={item} unconfirmed={unconfirmed} />
              </IssueOverview>
            ) : (
              <>
                <InvestigationNotices item={item} unconfirmed={unconfirmed} />
                <section>
                  <h3>
                    <ListChecks size={16} aria-hidden="true" />{' '}
                    {m.issues_recommendation_title()}
                  </h3>
                  {item.attention.required ? (
                    <p className="case-attention">
                      {item.attention.explanation}
                    </p>
                  ) : null}
                  {unconfirmed ? (
                    <p>{m.issues_recommendation_unconfirmed()}</p>
                  ) : historical ? (
                    <p>{m.issues_recommendation_historical()}</p>
                  ) : item.diagnosisStatus !== 'failed' &&
                    diagnosis &&
                    !['pending', 'failed'].includes(diagnosis.status) &&
                    diagnosis.nextSteps.length ? (
                    diagnosis.nextSteps.map((step) => (
                      <div className="case-step" key={step.code}>
                        <h4>
                          {step.kind === 'manual_intervention'
                            ? m.issues_step_manual()
                            : m.issues_step_investigate()}
                        </h4>
                        <p>{step.text}</p>
                        {step.preconditions.length ? (
                          <>
                            <h5>{m.issues_step_before()}</h5>
                            <ul>
                              {step.preconditions.map((text) => (
                                <li key={text}>{text}</li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                        <h5>{m.issues_step_expected()}</h5>
                        <ul>
                          {step.verificationCriteria.map((text) => (
                            <li key={text}>{text}</li>
                          ))}
                        </ul>
                        {step.capabilityLimitations.map((text) => (
                          <p className="case-caption" key={text}>
                            {text}
                          </p>
                        ))}
                      </div>
                    ))
                  ) : (
                    <p>{m.issues_recommendation_none()}</p>
                  )}
                  {diagnosis ? (
                    <p className="case-caption">
                      {m.issues_recommendation_version({
                        version: diagnosis.revision,
                        status: historical
                          ? m.issues_diagnosis_historical()
                          : diagnosisStatuses[diagnosis.status](),
                      })}
                    </p>
                  ) : null}
                </section>

                {diagnosis?.impact.exposedQuantity != null && (
                  <div className="report-exposure failed-exposure">
                    <Exposure
                      diagnosis={diagnosis}
                      note={m.issues_exposure_note()}
                    />
                  </div>
                )}
              </>
            )}
          </IssueSection>
          {expanded ? (
            <IssueSection
              section="findings"
              preview={
                diagnosis?.facts.length
                  ? m.issues_findings_fact_count({
                      count: diagnosis.facts.length,
                    })
                  : m.issues_findings_fact_count_none()
              }
            >
              <IssueFindings item={item} unconfirmed={unconfirmed} />
            </IssueSection>
          ) : (
            <Disclosure
              className="failed-disclosure"
              data-issue-section="findings"
              open={expanded}
            >
              <summary>
                <FileText size={18} aria-hidden="true" />
                <FindingsSummary item={item} />
                <ChevronRight size={16} aria-hidden="true" />
              </summary>
              <div className="failed-disclosure-content">
                <InvestigationReport
                  item={item}
                  unconfirmed={unconfirmed}
                  hideHeader
                  recordedOnly
                  progress={<></>}
                />
              </div>
            </Disclosure>
          )}
          {expanded ? (
            (progress ?? (
              <IssueSection section="execution">
                <p>{m.issues_activity_none()}</p>
              </IssueSection>
            ))
          ) : (
            <Disclosure
              className="failed-disclosure"
              data-issue-section="execution"
              open
            >
              <summary>
                <Activity size={18} aria-hidden="true" />
                <ActivitySummary item={item} />
                <ChevronRight size={16} aria-hidden="true" />
              </summary>
              <div className="failed-disclosure-content">
                {progress ?? (
                  <div>
                    <p>
                      {item.resolution === 'verified'
                        ? m.issues_resolution_verified_body()
                        : item.resolution === 'human_disposition'
                          ? m.issues_resolution_human_body()
                          : m.issues_activity_open_body()}
                    </p>
                  </div>
                )}
              </div>
            </Disclosure>
          )}
        </>
      )}
      {!hideHeader && !expanded && (
        <IssueRecordDetails key={item.id} item={item} />
      )}
    </article>
  );
}
