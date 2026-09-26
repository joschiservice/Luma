import type {
  CaseDetail,
  CaseReview,
  CaseSummary,
  Diagnosis,
} from '@luma/api-contract';
import {
  Activity,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  FileText,
  GitBranch,
  ListChecks,
  Package,
  RefreshCw,
  ShieldQuestion,
  Truck,
  Unplug,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '../primitives/alert';
import { Badge } from '../primitives/badge';
import { Button } from '../primitives/button';
import { Disclosure } from '../primitives/disclosure';
import { WorkspaceDate } from '../primitives/workspace-date';
import { IssueCollection } from './issue-collection';
import { IssueContext } from './issue-context';
import { IssueFindings } from './issue-findings';
import { IssueOverview } from './issue-overview';
import { IssueRecordDetails } from './issue-record-details';
import { IssueSection } from './issue-section';

/** Converts underscore-separated case codes to readable labels. */
export function caseLabel(value: string) {
  return value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Renders a case timestamp in the workspace display timezone. */
export function CaseTime({ value }: { value: string }) {
  return <WorkspaceDate value={value} />;
}

function issueStateLabel(item: CaseSummary): string | null {
  if (item.state === 'resolved')
    return item.resolution === 'verified' ? 'Verified' : 'Closed';
  const labels: Record<string, string> = {
    diagnosed: 'Investigation ready',
    proposed: 'Action proposed',
    awaiting_approval: 'Needs approval',
    allowed: 'Ready for action',
    executing: 'Action in progress',
    verifying: 'Verifying outcome',
    failed: 'Action failed',
    escalated: 'Needs review',
  };

  return labels[item.state] ?? null;
}

/** Displays the recorded issue state and severity. */
export function CaseStatus({ item }: { item: CaseSummary }) {
  return (
    <div className="case-badges">
      <Badge tone={item.severity === 'high' ? 'warning' : 'neutral'}>
        {caseLabel(item.severity)} severity
      </Badge>
      {issueStateLabel(item) && <Badge>{issueStateLabel(item)}</Badge>}
    </div>
  );
}

/** Renders a compact case summary for an inbox entry. */
export function CaseRow({ item }: { item: CaseSummary }) {
  const Icon =
    item.class === 'inventory_mismatch'
      ? Package
      : item.class === 'sync_failure'
        ? Unplug
        : item.class === 'stuck_fulfillment'
          ? Truck
          : GitBranch;

  return (
    <div className="issue-row">
      <Icon size={16} aria-hidden="true" className="issue-row-icon" />
      <div className="issue-row-copy">
        <strong className="case-row-summary">
          {item.summary.replace(/\.+$/, '')}
        </strong>
        <span className="case-row-subject">
          <span>
            {item.sources
              .map(
                (source) =>
                  ({
                    shopify: 'Shopify',
                    jtl: 'JTL',
                    'jtl-onprem': 'JTL-Wawi',
                    'jtl-cloud': 'JTL Cloud',
                  })[source] ?? caseLabel(source),
              )
              .join(' · ') || 'Source unknown'}
          </span>
          <span title={item.subject.id}>
            {item.subject.kind === 'sku' ? 'SKU' : caseLabel(item.subject.kind)}{' '}
            ID:{' '}
            {item.subject.id.length > 24
              ? `…${item.subject.id.slice(-8)}`
              : item.subject.id}
          </span>
        </span>
      </div>
      <div className="issue-row-meta">
        <Badge tone={item.severity === 'high' ? 'warning' : 'neutral'}>
          {caseLabel(item.severity)} severity
        </Badge>
        <span
          className={
            item.attention.required
              ? 'status-warning'
              : item.resolution === 'verified'
                ? 'status-success'
                : 'case-caption'
          }
        >
          {item.attention.required
            ? 'Needs review'
            : item.resolution === 'verified'
              ? 'Verified'
              : (issueStateLabel(item) ??
                (item.diagnosisStatus === 'pending'
                  ? 'Investigation pending'
                  : item.diagnosisStatus === 'failed'
                    ? 'Investigation failed'
                    : 'Open'))}
        </span>
        <span className="case-row-time">
          <CaseTime value={item.lastActivityAt} />
        </span>
      </div>
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
    <div className="case-loading" role="status" aria-label="Loading issues">
      <span />
      <span />
      <span />
      <span />
      <p>Loading issues…</p>
    </div>
  );
}

function Findings({ items }: { items: Diagnosis['facts'] }) {
  return (
    <ul className="case-findings">
      {items.map((item) => (
        <li key={item.code}>
          <p>{item.text}</p>
          {item.evidenceRefs.length ? (
            <Disclosure className="finding-sources">
              <summary>
                Evidence references ({item.evidenceRefs.length})
              </summary>
              <ul>
                {item.evidenceRefs.map((ref) => (
                  <li key={ref}>
                    <code>{ref}</code>
                  </li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

type InvestigationProps = {
  expanded?: boolean;
  embedded?: boolean;
  item: CaseDetail;
  progress?: ReactNode;
  review?: CaseReview;
  unconfirmed?: boolean;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean;
};

/**
 * Presents investigation status, findings, and next steps without initiating execution.
 * Expanded pages open findings and display record metadata in their own surrounding layout.
 */
export function CaseInvestigation(props: InvestigationProps) {
  if (props.item.diagnosisStatus === 'failed')
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
  const evidenceCount = diagnosis?.provenance.evidence.length ?? 0;
  const historical =
    item.freshness === 'stale' ||
    diagnosis?.superseded ||
    item.state === 'resolved';

  return (
    <article className="failed-investigation" aria-label="Issue investigation">
      {!embedded && (
        <header className="failed-investigation-header">
          <div className="failed-investigation-context">
            <span className="failed-priority">
              {caseLabel(item.severity)} severity
            </span>
          </div>
          <h2>{item.summary.replace(/\.+$/, '')}</h2>
          <IssueContext item={item} />
        </header>
      )}
      <IssueSection section="overview" enabled={expanded}>
        <section
          className="investigation-failure"
          aria-label="Investigation status"
        >
          <CircleAlert size={22} aria-hidden="true" />
          <div>
            <h3>Investigation failed</h3>
            <p>
              The investigation could not finish. No recommendation is ready.
            </p>
          </div>
        </section>
        {unconfirmed || historical ? (
          <div className="failed-context-warning" role="status">
            <ShieldQuestion size={18} aria-hidden="true" />
            <p>
              {unconfirmed
                ? 'Current state is unconfirmed. Reconnect or refresh before acting.'
                : 'Recorded findings are historical. Fresh evidence is needed before acting.'}
            </p>
          </div>
        ) : null}
        <section className="failed-next-step" aria-label="Next step">
          <h3>
            <RefreshCw size={16} aria-hidden="true" />
            Next step
          </h3>
          <div className="failed-update-action">
            <p>Check whether new findings are available.</p>
            {onRefresh ? (
              <Button
                variant="outline"
                onClick={onRefresh}
                disabled={refreshing}
              >
                <RefreshCw aria-hidden="true" />
                {refreshing ? 'Checking…' : 'Check for updates'}
              </Button>
            ) : null}
          </div>
          <p className="failed-help">
            {onRefresh
              ? 'Checks the latest status without restarting the investigation.'
              : 'Refresh the issue to check the latest status.'}
          </p>
          {item.attention.required && (
            <div className="failed-review-request">
              <CircleAlert size={16} aria-hidden="true" />
              <div>
                <strong>Recorded review request</strong>
                <p>{item.attention.explanation}</p>
              </div>
            </div>
          )}
        </section>
        <section
          className="failed-recorded-context"
          aria-label="Recorded context"
        >
          <div className="failed-context-heading">
            <h3>
              <FileText size={16} aria-hidden="true" />
              Recorded context
            </h3>
            <span className="failed-freshness">
              {unconfirmed
                ? 'Unconfirmed'
                : historical
                  ? 'Historical evidence'
                  : item.freshness === 'fresh'
                    ? 'Fresh evidence'
                    : 'Freshness unknown'}
            </span>
          </div>
          {diagnosis?.impact.exposedQuantity != null ? (
            <div className="failed-exposure">
              <div>
                <span>Potential exposure</span>
                <p>
                  Recorded before the investigation completed. Does not confirm
                  lost sales or oversold orders.
                </p>
              </div>
              <strong>
                {diagnosis.impact.exposedQuantity}{' '}
                <small>{diagnosis.impact.unit}</small>
              </strong>
            </div>
          ) : (
            <p className="failed-help">
              {diagnosis?.facts.length
                ? 'Recorded findings are available below. Impact has not been established.'
                : 'No findings are available yet. Impact remains unknown.'}
            </p>
          )}
        </section>
      </IssueSection>
      {expanded ? (
        <IssueSection
          section="findings"
          preview={`${diagnosis?.facts.length ?? 0} recorded facts`}
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
            <span>
              Findings & evidence
              <small>
                {diagnosis?.facts.length ?? 0} findings · {evidenceCount}{' '}
                evidence records
              </small>
            </span>
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
            <p>No activity is available yet.</p>
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
            <span>
              Activity & history
              <small>
                {issueStateLabel(item) ?? 'Open issue'} · Updated{' '}
                <CaseTime value={item.lastActivityAt} />
              </small>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </summary>
          <div className="failed-disclosure-content">
            {progress ?? (
              <>
                <p>
                  {item.resolution === 'verified'
                    ? 'Resolved with fresh verification evidence.'
                    : item.resolution === 'human_disposition'
                      ? 'Closed by human disposition. This does not establish a verified correction.'
                      : 'The issue remains open.'}
                </p>
                <p className="failed-recorded-time">
                  <Clock3 size={16} aria-hidden="true" />
                  Detected <CaseTime value={item.detectedAt} />
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
  unconfirmed = false,
  hideHeader = false,
  recordedOnly = false,
  embedded = false,
  expanded = false,
}: {
  item: CaseDetail;
  progress?: ReactNode;
  review?: CaseReview;
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
      aria-label="Issue investigation"
    >
      {!hideHeader && !embedded && (
        <header>
          <CaseStatus item={item} />
          <h2>{item.summary.replace(/\.+$/, '')}</h2>
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
              <Activity size={16} aria-hidden="true" /> Why it matters
            </h3>
            {diagnosis?.impact.observed.length ? (
              <>
                <h4>Observed impact</h4>
                <Findings items={diagnosis.impact.observed} />
              </>
            ) : null}
            {diagnosis?.impact.potential.length ? (
              <>
                <h4>Potential exposure</h4>
                <Findings items={diagnosis.impact.potential} />
              </>
            ) : null}
            {!diagnosis?.impact.observed.length &&
            !diagnosis?.impact.potential.length ? (
              <p>Impact is unknown until the evidence supports a conclusion.</p>
            ) : null}
            <p className="case-caption">
              Revenue impact is unknown. Potential exposure does not establish
              lost sales or oversold orders.
            </p>
          </section>
          <section>
            <h3>
              <ListChecks size={16} aria-hidden="true" /> Investigation findings
            </h3>
            {historical ? (
              <p className="case-caption">
                These findings describe the recorded observations, not current
                conditions.
              </p>
            ) : null}
            <h4>Established facts</h4>
            {diagnosis?.facts.length ? (
              <Findings items={diagnosis.facts} />
            ) : (
              <p>No established findings yet.</p>
            )}
            {diagnosis?.constraints.length ? (
              <>
                <h4 className="findings-uncertainty-heading">
                  <ShieldQuestion size={14} aria-hidden="true" /> Uncertainty
                  and constraints
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
                  <span>Hypotheses and missing checks</span>
                  <span className="hypothesis-count">
                    {diagnosis.hypotheses.length}
                  </span>
                  <ChevronRight size={14} aria-hidden="true" />
                </summary>
                {diagnosis.hypotheses.map((h) => (
                  <div className="hypothesis-item" key={h.code}>
                    <span className="hypothesis-status">Unconfirmed</span>
                    <p className="hypothesis-text">{h.text}</p>
                    {h.missingChecks.length > 0 && (
                      <div className="hypothesis-checks">
                        <h4>Checks needed</h4>
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
                      <Disclosure className="finding-sources">
                        <summary>
                          Evidence references ({h.evidenceRefs.length})
                        </summary>
                        <ul>
                          {h.evidenceRefs.map((ref) => (
                            <li key={ref}>
                              <code>{ref}</code>
                            </li>
                          ))}
                        </ul>
                      </Disclosure>
                    )}
                  </div>
                ))}
              </Disclosure>
            ) : null}
          </section>
          <section>
            <h3>
              <Database size={16} aria-hidden="true" /> Supporting evidence
            </h3>
            <p className="case-caption">
              Freshness: {caseLabel(item.freshness)}. Source update time may be
              unknown.
            </p>
            <IssueCollection
              title="Supporting evidence"
              noun="supporting evidence records"
              items={[...(diagnosis?.provenance.evidence ?? [])].sort((a, b) =>
                b.observedAt.localeCompare(a.observedAt),
              )}
              filters={[
                {
                  label: 'Source',
                  value: (entry) =>
                    entry.source
                      ? `${entry.source.provider} · ${entry.source.resource}`
                      : 'Canonical evidence',
                },
              ]}
              renderItems={(entries) =>
                entries.length ? (
                  entries.map((e) => (
                    <Disclosure className="case-evidence" key={e.id}>
                      <summary>
                        {e.source
                          ? `${e.source.provider} · ${e.source.resource}`
                          : 'Canonical evidence'}{' '}
                        <span>
                          Observed <CaseTime value={e.observedAt} />
                        </span>
                      </summary>
                      <dl>
                        <dt>Evidence ID</dt>
                        <dd>
                          <code>{e.id}</code>
                        </dd>
                        <dt>Observed</dt>
                        <dd>
                          <CaseTime value={e.observedAt} />
                        </dd>
                        <dt>Source updated</dt>
                        <dd>
                          {e.sourceUpdatedAt ? (
                            <CaseTime value={e.sourceUpdatedAt} />
                          ) : (
                            'Unknown'
                          )}
                        </dd>
                        {e.source ? (
                          <>
                            <dt>Source object</dt>
                            <dd>{e.source.externalId}</dd>
                            <dt>Source scope</dt>
                            <dd>{e.source.scopeKey || 'Not specified'}</dd>
                          </>
                        ) : null}
                        <dt>Adapter</dt>
                        <dd>{e.adapterVersion}</dd>
                        <dt>Schema</dt>
                        <dd>{e.schemaVersion}</dd>
                      </dl>
                    </Disclosure>
                  ))
                ) : (
                  <p>No evidence references are available yet.</p>
                )
              }
            />
            {diagnosis?.provenance.mappingVersions.length ? (
              <p className="case-caption">
                Mapping versions:{' '}
                {diagnosis.provenance.mappingVersions.join(', ')}
              </p>
            ) : null}
            {diagnosis ? (
              <p className="case-caption">
                Configuration: {diagnosis.provenance.configVersion} · Rules:{' '}
                {diagnosis.provenance.ruleVersion}
              </p>
            ) : null}
          </section>
        </>
      ) : (
        <>
          <IssueSection
            section="overview"
            enabled={expanded}
            status={
              !unconfirmed &&
              item.freshness !== 'stale' &&
              !diagnosis?.superseded &&
              item.state !== 'resolved' &&
              diagnosis &&
              !['pending', 'failed'].includes(item.diagnosisStatus) &&
              !['pending', 'failed'].includes(diagnosis.status) &&
              item.attention.required ? (
                <Badge tone="warning">Manual review required</Badge>
              ) : null
            }
          >
            {expanded ? (
              <IssueOverview
                item={item}
                unconfirmed={unconfirmed}
                review={review}
              >
                {!recordedOnly && (
                  <>
                    {unconfirmed ? (
                      <CaseNotice title="Current investigation is unconfirmed">
                        These are the last confirmed findings. Reconnect or
                        refresh before choosing a correction.
                      </CaseNotice>
                    ) : null}
                    {item.freshness === 'stale' ? (
                      <CaseNotice title="Evidence is stale">
                        Current conditions are unknown. Fresh observations are
                        needed before choosing a correction.
                      </CaseNotice>
                    ) : null}
                    {item.diagnosisStatus === 'pending' ? (
                      <CaseNotice title="Investigation pending">
                        The issue has been detected. Findings and next steps
                        will appear when investigation completes.
                      </CaseNotice>
                    ) : null}
                    {item.diagnosisStatus === 'failed' ? (
                      <CaseNotice title="Investigation could not finish">
                        Refresh to check for a completed investigation. No
                        recommendation is ready.
                      </CaseNotice>
                    ) : null}
                    {item.diagnosisStatus === 'insufficient_evidence' &&
                    item.freshness !== 'stale' ? (
                      <CaseNotice title="More evidence is needed">
                        Mappings, authority or observations do not yet support a
                        confident conclusion.
                      </CaseNotice>
                    ) : null}
                  </>
                )}
              </IssueOverview>
            ) : (
              <>
                {!recordedOnly && (
                  <>
                    {unconfirmed ? (
                      <CaseNotice title="Current investigation is unconfirmed">
                        These are the last confirmed findings. Reconnect or
                        refresh before choosing a correction.
                      </CaseNotice>
                    ) : null}
                    {item.freshness === 'stale' ? (
                      <CaseNotice title="Evidence is stale">
                        Current conditions are unknown. Fresh observations are
                        needed before choosing a correction.
                      </CaseNotice>
                    ) : null}
                    {item.diagnosisStatus === 'pending' ? (
                      <CaseNotice title="Investigation pending">
                        The issue has been detected. Findings and next steps
                        will appear when investigation completes.
                      </CaseNotice>
                    ) : null}
                    {item.diagnosisStatus === 'failed' ? (
                      <CaseNotice title="Investigation could not finish">
                        Refresh to check for a completed investigation. No
                        recommendation is ready.
                      </CaseNotice>
                    ) : null}
                    {item.diagnosisStatus === 'insufficient_evidence' &&
                    item.freshness !== 'stale' ? (
                      <CaseNotice title="More evidence is needed">
                        Mappings, authority or observations do not yet support a
                        confident conclusion.
                      </CaseNotice>
                    ) : null}
                  </>
                )}
                <section>
                  <h3>
                    <ListChecks size={16} aria-hidden="true" /> Recommended next
                    step
                  </h3>
                  {item.attention.required ? (
                    <p className="case-attention">
                      {item.attention.explanation}
                    </p>
                  ) : null}
                  {unconfirmed ? (
                    <p>
                      Current recommendations will appear when the investigation
                      is confirmed.
                    </p>
                  ) : historical ? (
                    <p>
                      This investigation is historical. Its recommendations are
                      no longer current.
                    </p>
                  ) : item.diagnosisStatus !== 'failed' &&
                    diagnosis &&
                    !['pending', 'failed'].includes(diagnosis.status) &&
                    diagnosis.nextSteps.length ? (
                    diagnosis.nextSteps.map((step) => (
                      <div className="case-step" key={step.code}>
                        <h4>
                          {step.kind === 'manual_intervention'
                            ? 'Operator review'
                            : 'Investigate'}
                        </h4>
                        <p>{step.text}</p>
                        {step.preconditions.length ? (
                          <>
                            <h5>Before proceeding</h5>
                            <ul>
                              {step.preconditions.map((text) => (
                                <li key={text}>{text}</li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                        <h5>Expected result and verification</h5>
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
                    <p>No current recommendation is available.</p>
                  )}
                  {diagnosis ? (
                    <p className="case-caption">
                      Investigation revision {diagnosis.revision} ·{' '}
                      {historical ? 'Historical' : caseLabel(diagnosis.status)}
                    </p>
                  ) : null}
                </section>

                {diagnosis?.impact.exposedQuantity != null && (
                  <div className="report-exposure failed-exposure">
                    <div>
                      <span>Potential exposure</span>
                      <p>Does not confirm lost sales or oversold orders.</p>
                    </div>
                    <strong>
                      {diagnosis.impact.exposedQuantity}{' '}
                      <small>{diagnosis.impact.unit}</small>
                    </strong>
                  </div>
                )}
              </>
            )}
          </IssueSection>
          {expanded ? (
            <IssueSection
              section="findings"
              preview={`${diagnosis?.facts.length ?? 0} recorded facts`}
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
                <span>
                  Findings &amp; evidence
                  <small>
                    {diagnosis?.facts.length ?? 0} findings ·{' '}
                    {diagnosis?.provenance.evidence.length ?? 0} evidence
                    records
                  </small>
                </span>
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
                <p>No activity is available yet.</p>
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
                <span>
                  Activity &amp; history
                  <small>
                    {issueStateLabel(item) ?? 'Open issue'} · Updated{' '}
                    <CaseTime value={item.lastActivityAt} />
                  </small>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </summary>
              <div className="failed-disclosure-content">
                {progress ?? (
                  <div>
                    <p>
                      {item.resolution === 'verified'
                        ? 'Resolved with fresh verification evidence.'
                        : item.resolution === 'human_disposition'
                          ? 'Closed by human disposition. This does not establish a verified correction.'
                          : 'This issue is open. Activity will appear here as work progresses.'}
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
