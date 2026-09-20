import type { CaseDetail, CaseSummary, Diagnosis } from '@luma/api-contract';
import type { ReactNode } from 'react';

export function caseLabel(value: string) {
  return value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}
export function CaseTime({ value }: { value: string }) {
  return (
    <time dateTime={value}>
      {new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC
    </time>
  );
}
export function CaseStatus({ item }: { item: CaseSummary }) {
  return (
    <div className="case-badges">
      <span className={`case-severity case-severity-${item.severity}`}>
        {caseLabel(item.severity)} severity
      </span>
      <span>{caseLabel(item.state)}</span>
    </div>
  );
}
export function CaseRow({ item }: { item: CaseSummary }) {
  return (
    <>
      <CaseStatus item={item} />
      <strong className="case-row-summary">{item.summary}</strong>
      <span className="case-row-subject">
        {item.subject.id} ·{' '}
        {item.sources.join(' / ') || caseLabel(item.subject.kind)}
      </span>
      <span className="case-row-attention">
        {item.attention.required
          ? item.attention.explanation
          : caseLabel(item.diagnosisStatus)}
      </span>
      <span className="case-row-time">
        Last activity <CaseTime value={item.lastActivityAt} />
      </span>
    </>
  );
}
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
    <div className="case-notice" role={error ? 'alert' : 'status'}>
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
export function CaseLoading() {
  return (
    <div className="case-loading" role="status" aria-label="Loading cases">
      <span />
      <span />
      <span />
      <span />
      <p>Reading cases…</p>
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
            <small>Evidence: {item.evidenceRefs.join(', ')}</small>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
export function CaseInvestigation({
  item,
  progress,
}: {
  item: CaseDetail;
  progress?: ReactNode;
}) {
  const diagnosis = item.diagnosis;
  const historical =
    diagnosis?.superseded ||
    item.freshness === 'stale' ||
    item.state === 'resolved';
  return (
    <article className="case-investigation" aria-label="Case investigation">
      <header>
        <p className="case-kicker">
          {caseLabel(item.class)} · Case {item.id.slice(0, 8)}
        </p>
        <CaseStatus item={item} />
        <h2>{item.summary}</h2>
        <p className="case-subject">
          {caseLabel(item.subject.kind)}: {item.subject.id}
        </p>
        {item.subject.scope.length ? (
          <details>
            <summary>Affected scope</summary>
            <ul>
              {item.subject.scope.map((scope) => (
                <li key={scope}>{scope}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <p className="case-caption">
          Detected <CaseTime value={item.detectedAt} /> ·{' '}
          {item.sources.join(' / ') || 'Source system unknown'}
        </p>
      </header>
      {item.freshness === 'stale' ? (
        <CaseNotice title="Evidence is stale">
          Current conditions are unknown. Fresh observations are needed before
          choosing a correction.
        </CaseNotice>
      ) : null}
      {item.diagnosisStatus === 'pending' ? (
        <CaseNotice title="Investigation pending">
          The case is detected. Findings and next steps will appear when
          investigation completes.
        </CaseNotice>
      ) : null}
      {item.diagnosisStatus === 'failed' ? (
        <CaseNotice title="Investigation could not finish">
          Refresh to check for a completed investigation. No recommendation is
          ready.
        </CaseNotice>
      ) : null}
      {item.diagnosisStatus === 'insufficient_evidence' &&
      item.freshness !== 'stale' ? (
        <CaseNotice title="More evidence is needed">
          Mappings, authority or observations do not yet support a confident
          conclusion.
        </CaseNotice>
      ) : null}
      <section>
        <h3>
          <span>01</span> Why it matters
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
        {diagnosis?.impact.exposedQuantity != null ? (
          <p className="case-exposure">
            {diagnosis.impact.exposedQuantity}{' '}
            <span>{diagnosis.impact.unit} potentially exposed</span>
          </p>
        ) : null}
        <p className="case-caption">
          Revenue impact is unknown. Potential exposure does not establish lost
          sales or oversold orders.
        </p>
      </section>
      <section>
        <h3>
          <span>02</span> Recommended next step
        </h3>
        {item.attention.required ? (
          <p className="case-attention">{item.attention.explanation}</p>
        ) : null}
        {historical ? (
          <p>
            This investigation is historical. Its recommendations are no longer
            current.
          </p>
        ) : diagnosis &&
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
      <section>
        <h3>
          <span>03</span> Why Luma thinks this
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
            <h4>Uncertainty and constraints</h4>
            <ul>
              {diagnosis.constraints.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </>
        ) : null}
        {diagnosis?.hypotheses.length ? (
          <details>
            <summary>
              Hypotheses and missing checks ({diagnosis.hypotheses.length})
            </summary>
            {diagnosis.hypotheses.map((h) => (
              <div key={h.code}>
                <h4>Unsubstantiated hypothesis</h4>
                <p>{h.text}</p>
                <ul>
                  {h.missingChecks.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
                <small>Evidence: {h.evidenceRefs.join(', ')}</small>
              </div>
            ))}
          </details>
        ) : null}
      </section>
      <section>
        <h3>
          <span>04</span> Supporting evidence
        </h3>
        <p className="case-caption">
          Freshness: {caseLabel(item.freshness)}. Source update time may be
          unknown.
        </p>
        {diagnosis?.provenance.evidence.length ? (
          diagnosis.provenance.evidence.map((e) => (
            <details className="case-evidence" key={e.id}>
              <summary>
                {e.source
                  ? `${e.source.provider} · ${e.source.resource}`
                  : 'Canonical evidence'}{' '}
                <span>{e.id}</span>
              </summary>
              <dl>
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
            </details>
          ))
        ) : (
          <p>No evidence references are available yet.</p>
        )}
        {diagnosis?.provenance.mappingVersions.length ? (
          <p className="case-caption">
            Mapping versions: {diagnosis.provenance.mappingVersions.join(', ')}
          </p>
        ) : null}
        {diagnosis ? (
          <p className="case-caption">
            Configuration: {diagnosis.provenance.configVersion} · Rules:{' '}
            {diagnosis.provenance.ruleVersion}
          </p>
        ) : null}
      </section>
      {progress ?? (
        <section>
          <h3>
            <span>05</span> Case progress
          </h3>
          <p>
            {item.resolution === 'verified'
              ? 'Resolved with fresh verification evidence.'
              : item.resolution === 'human_disposition'
                ? 'Closed by human disposition. This does not establish a verified correction.'
                : `${caseLabel(item.state)}. The case remains active until a terminal disposition is recorded.`}
          </p>
          <p className="case-caption">
            Last activity <CaseTime value={item.lastActivityAt} />
          </p>
        </section>
      )}
    </article>
  );
}
