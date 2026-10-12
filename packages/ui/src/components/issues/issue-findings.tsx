import type {
  CaseDetail,
  CaseEvidencePage,
  Diagnosis,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';

import { Disclosure } from '../primitives/disclosure';
import { WorkspaceDate } from '../primitives/workspace-date';
import { freshnessLabel, quantityLabel, unitLabel } from './case-presentation';
import { IssueCollection } from './issue-collection';

type Fact = Diagnosis['facts'][number];

type Evidence = Diagnosis['provenance']['evidence'][number] & {
  completeness?: CaseEvidencePage['items'][number]['completeness'];
};

function sourceLabel(provider: string | null | undefined) {
  if (!provider) return null;
  const names: Record<string, string> = {
    shopify: 'Shopify',
    'jtl-onprem': 'JTL-Wawi',
    'jtl-cloud': 'JTL Cloud',
    jtl: 'JTL',
  };

  return names[provider.toLowerCase()] ?? provider;
}

/** Names where a piece of evidence came from, such as “Shopify · Inventory”, or Luma’s own record. */
export function evidenceSourceLabel(entry: Pick<Evidence, 'source'>) {
  return entry.source
    ? `${entry.source.provider} · ${entry.source.resource}`
    : m.issues_evidence_luma_record();
}

const completeness = {
  complete: m.issues_evidence_complete,
  incomplete: m.issues_evidence_incomplete,
  unknown: m.common_unknown,
} satisfies Record<NonNullable<Evidence['completeness']>, () => string>;

/** Shows one piece of evidence: its source, when Luma read it and how to find it in the source system. */
export function EvidenceRecord({ entry }: { entry: Evidence }) {
  return (
    <Disclosure className="case-evidence">
      <summary>
        {evidenceSourceLabel(entry)}{' '}
        <span>
          {rich(m.issues_evidence_read_at, {
            time: <WorkspaceDate value={entry.observedAt} />,
          })}
        </span>
      </summary>
      <dl>
        <dt>{m.issues_evidence_id()}</dt>
        <dd>
          <code>{entry.id}</code>
        </dd>
        <dt>{m.issues_evidence_read()}</dt>
        <dd>
          <WorkspaceDate value={entry.observedAt} />
        </dd>
        <dt>{m.issues_evidence_source_updated()}</dt>
        <dd>
          {entry.sourceUpdatedAt ? (
            <WorkspaceDate value={entry.sourceUpdatedAt} />
          ) : (
            m.common_unknown()
          )}
        </dd>
        {entry.completeness ? (
          <>
            <dt>{m.issues_evidence_completeness()}</dt>
            <dd>{completeness[entry.completeness]()}</dd>
          </>
        ) : null}
        {entry.source ? (
          <>
            <dt>{m.issues_evidence_source_record()}</dt>
            <dd>{entry.source.externalId}</dd>
            <dt>{m.issues_evidence_source_scope()}</dt>
            <dd>{entry.source.scopeKey || m.issues_not_specified()}</dd>
          </>
        ) : null}
        <dt>{m.issues_evidence_technical_version()}</dt>
        <dd>
          {entry.adapterVersion} · {entry.schemaVersion}
        </dd>
      </dl>
    </Disclosure>
  );
}

function Sources({
  refs,
  diagnosis,
}: {
  refs: string[];
  diagnosis: Diagnosis;
}) {
  const ids = [...new Set(refs)];
  if (!ids.length) return null;

  return (
    <Disclosure className="finding-sources">
      <summary>{m.issues_findings_source_count({ count: ids.length })}</summary>
      <ul>
        {ids.map((id) => {
          const evidence = diagnosis.provenance.evidence.find(
            (item) => item.id === id,
          );

          return (
            <li key={id}>
              {evidence
                ? evidenceSourceLabel(evidence)
                : m.issues_findings_evidence_reference()}
              <code>{id}</code>
            </li>
          );
        })}
      </ul>
    </Disclosure>
  );
}

/**
 * Localizes the facts that tell how a raised stock gap relates to provider sync. They use the
 * exact templates inventory diagnosis emits; other facts keep their recorded text.
 */
function factText(fact: Fact) {
  if (fact.code === 'sync_did_not_close_gap') {
    const match = fact.text.match(
      /^Luma first saw this gap at (\S+) and waited (\d+) minutes for sync; the gap is still open\.$/,
    );
    if (match)
      return rich(m.issues_findings_sync_not_closed, {
        time: <WorkspaceDate value={match[1]!} />,
        minutes: Number(match[2]),
      });
  }
  if (fact.code === 'raised_oversell_guard')
    return m.issues_findings_raised_oversell_guard();
  if (fact.code === 'no_recent_agreement')
    return m.issues_findings_no_recent_agreement();

  return fact.text;
}

function Facts({ facts, diagnosis }: { facts: Fact[]; diagnosis: Diagnosis }) {
  return (
    <ul className="issue-finding-rows">
      {facts.map((fact) => (
        <li key={fact.code}>
          <p>{factText(fact)}</p>
          <Sources refs={fact.evidenceRefs} diagnosis={diagnosis} />
        </li>
      ))}
    </ul>
  );
}

/** Presents recorded facts before uncertainty, keeping provenance accessible in the full-list view. */
export function IssueFindings({
  item,
  unconfirmed = false,
}: {
  item: CaseDetail;
  unconfirmed?: boolean;
}) {
  const diagnosis = item.diagnosis;
  if (!diagnosis) return <p>{m.issues_findings_none()}</p>;
  const quantities = diagnosis.facts.find(
    (fact) => fact.code === 'reported_availability',
  );
  // These are the exact templates emitted by inventory diagnosis. Other findings retain their text.
  const match =
    item.class === 'inventory_mismatch'
      ? quantities?.text.match(
          /^The left source reported (-?\d+(?:\.\d+)?) ([^;]+); the right source reported (-?\d+(?:\.\d+)?) (.+)\.$/,
        )
      : null;
  const difference = diagnosis.facts.find(
    (fact) => fact.code === 'signed_difference',
  );
  const delta = difference?.text.match(
    /^Left minus right availability is (-?\d+(?:\.\d+)?) (.+)\.$/,
  );
  const comparable =
    match && delta && match[2] === match[4] && match[2] === delta[2];
  const facts = diagnosis.facts.filter(
    (fact) =>
      !match || (fact !== quantities && (!comparable || fact !== difference)),
  );
  const historical =
    item.freshness === 'stale' ||
    diagnosis.superseded ||
    item.state === 'resolved';
  const evidence = [...diagnosis.provenance.evidence].sort((a, b) =>
    b.observedAt.localeCompare(a.observedAt),
  );

  return (
    <div className="issue-findings">
      {historical || unconfirmed ? (
        <p className="case-caption">
          {unconfirmed
            ? m.issues_findings_unconfirmed()
            : m.issues_findings_historical()}
        </p>
      ) : null}
      {match ? (
        <div className="issue-findings-comparison">
          <h3>{m.issues_findings_reported_availability()}</h3>
          <dl>
            <div>
              <dt>
                {sourceLabel(item.inventorySources?.left) ??
                  m.issues_findings_source_unknown()}
              </dt>
              <dd>
                {quantityLabel(match[1]!)}{' '}
                <small>{unitLabel(match[2]!, match[1]!)}</small>
              </dd>
            </div>
            <div>
              <dt>
                {sourceLabel(item.inventorySources?.right) ??
                  m.issues_findings_source_unknown()}
              </dt>
              <dd>
                {quantityLabel(match[3]!)}{' '}
                <small>{unitLabel(match[4]!, match[3]!)}</small>
              </dd>
            </div>
            {comparable ? (
              <div>
                <dt>{m.issues_findings_difference()}</dt>
                <dd>
                  {quantityLabel(delta[1]!.replace(/^-/, ''))}{' '}
                  <small>{unitLabel(delta[2]!, delta[1]!)}</small>
                </dd>
              </div>
            ) : null}
          </dl>
          <Sources
            refs={[
              ...quantities!.evidenceRefs,
              ...(comparable ? difference!.evidenceRefs : []),
            ]}
            diagnosis={diagnosis}
          />
        </div>
      ) : null}
      {facts.length ? (
        <div className="issue-findings-block">
          <h3>{m.issues_findings_confirmed_facts()}</h3>
          <Facts facts={facts} diagnosis={diagnosis} />
        </div>
      ) : !match ? (
        <p>{m.issues_findings_none()}</p>
      ) : null}
      {diagnosis.impact.observed.length ? (
        <div className="issue-findings-block">
          <h3>{m.issues_findings_confirmed_impact()}</h3>
          <Facts facts={diagnosis.impact.observed} diagnosis={diagnosis} />
        </div>
      ) : null}
      {diagnosis.constraints.length || diagnosis.hypotheses.length ? (
        <div className="issue-findings-block">
          <h3>{m.issues_findings_uncertain()}</h3>
          {diagnosis.hypotheses.length ? (
            <p>{m.issues_findings_causes_unconfirmed()}</p>
          ) : null}
          <ul className="issue-findings-constraints">
            {diagnosis.constraints.map((text) => (
              <li key={text}>
                {text ===
                'Quantities describe observed availability. Oversold orders, lost revenue and synchronization failure are not established.'
                  ? m.issues_findings_inventory_limits()
                  : text}
              </li>
            ))}
          </ul>
          {diagnosis.hypotheses.length ? (
            <Disclosure className="issue-findings-causes">
              <summary>
                {m.issues_findings_causes({
                  count: diagnosis.hypotheses.length,
                })}
              </summary>
              {diagnosis.hypotheses.map((hypothesis) => (
                <div className="issue-findings-cause" key={hypothesis.code}>
                  <span className="case-caption">
                    {m.issues_findings_unconfirmed_label()}
                  </span>
                  <p>{hypothesis.text}</p>
                  {hypothesis.missingChecks.length ? (
                    <>
                      <h4>{m.issues_findings_checks_needed()}</h4>
                      <ul>
                        {hypothesis.missingChecks.map((text) => (
                          <li key={text}>{text}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <Sources
                    refs={hypothesis.evidenceRefs}
                    diagnosis={diagnosis}
                  />
                  {hypothesis.contradictingEvidenceRefs.length ? (
                    <>
                      <h4>{m.issues_findings_contradicting_evidence()}</h4>
                      <Sources
                        refs={hypothesis.contradictingEvidenceRefs}
                        diagnosis={diagnosis}
                      />
                    </>
                  ) : null}
                </div>
              ))}
            </Disclosure>
          ) : null}
        </div>
      ) : null}
      {diagnosis.impact.potential.length ? (
        <Disclosure className="issue-findings-impact">
          <summary>{m.issues_findings_potential_impact()}</summary>
          <Facts facts={diagnosis.impact.potential} diagnosis={diagnosis} />
          <p className="case-caption">
            {m.issues_findings_potential_impact_note()}
          </p>
        </Disclosure>
      ) : null}
      <div className="issue-findings-footer">
        <h3>{m.common_sources()}</h3>
        <p className="case-caption">
          {m.issues_findings_sources_summary({
            count: evidence.length,
            freshness: freshnessLabel(item.freshness),
          })}
        </p>
        <IssueCollection
          title={m.issues_evidence_supporting_title()}
          noun="evidence"
          previewCount={0}
          triggerLabel={m.issues_evidence_supporting_view()}
          items={evidence}
          filters={[{ label: m.common_source(), value: evidenceSourceLabel }]}
          renderItems={(entries) =>
            entries.map((entry) => (
              <EvidenceRecord key={entry.id} entry={entry} />
            ))
          }
        />
        <Disclosure className="issue-findings-technical">
          <summary>{m.issues_findings_technical()}</summary>
          <dl>
            <dt>{m.issues_findings_link_versions()}</dt>
            <dd>
              {diagnosis.provenance.mappingVersions.join(', ') ||
                m.issues_not_recorded()}
            </dd>
            <dt>{m.issues_findings_configuration()}</dt>
            <dd>{diagnosis.provenance.configVersion}</dd>
            <dt>{m.issues_findings_rules()}</dt>
            <dd>{diagnosis.provenance.ruleVersion}</dd>
          </dl>
        </Disclosure>
      </div>
    </div>
  );
}
