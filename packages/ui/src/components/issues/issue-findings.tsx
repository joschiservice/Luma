import type { CaseDetail, Diagnosis } from '@luma/api-contract';

import { Disclosure } from '../primitives/disclosure';
import { IssueCollection } from './issue-collection';

type Fact = Diagnosis['facts'][number];

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

function numberLabel(value: string) {
  return value.includes('.')
    ? value.replace(/0+$/, '').replace(/\.$/, '')
    : value;
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
      <summary>
        {ids.length} {ids.length === 1 ? 'source' : 'sources'}
      </summary>
      <ul>
        {ids.map((id) => {
          const evidence = diagnosis.provenance.evidence.find(
            (item) => item.id === id,
          );

          return (
            <li key={id}>
              {evidence?.source
                ? `${evidence.source.provider} · ${evidence.source.resource}`
                : 'Evidence reference'}
              <code>{id}</code>
            </li>
          );
        })}
      </ul>
    </Disclosure>
  );
}

function Facts({ facts, diagnosis }: { facts: Fact[]; diagnosis: Diagnosis }) {
  return (
    <ul className="issue-finding-rows">
      {facts.map((fact) => (
        <li key={fact.code}>
          <p>{fact.text}</p>
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
  if (!diagnosis) return <p>No established findings yet.</p>;
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
  const unit = (value: string) => (value === 'each' ? 'units' : value);
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
            ? 'Current state is unconfirmed. These are the last recorded findings.'
            : 'These findings describe historical observations, not current conditions.'}
        </p>
      ) : null}
      {match ? (
        <div className="issue-findings-comparison">
          <h3>Observed availability</h3>
          <dl>
            <div>
              <dt>
                {sourceLabel(item.inventorySources?.left) ??
                  'Source not identified'}
              </dt>
              <dd>
                {numberLabel(match[1]!)} <small>{unit(match[2]!)}</small>
              </dd>
            </div>
            <div>
              <dt>
                {sourceLabel(item.inventorySources?.right) ??
                  'Source not identified'}
              </dt>
              <dd>
                {numberLabel(match[3]!)} <small>{unit(match[4]!)}</small>
              </dd>
            </div>
            {comparable ? (
              <div>
                <dt>Difference</dt>
                <dd>
                  {numberLabel(delta[1]!.replace(/^-/, ''))}{' '}
                  <small>{unit(delta[2]!)}</small>
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
          <h3>Confirmed facts</h3>
          <Facts facts={facts} diagnosis={diagnosis} />
        </div>
      ) : !match ? (
        <p>No established findings yet.</p>
      ) : null}
      {diagnosis.impact.observed.length ? (
        <div className="issue-findings-block">
          <h3>Observed impact</h3>
          <Facts facts={diagnosis.impact.observed} diagnosis={diagnosis} />
        </div>
      ) : null}
      {diagnosis.constraints.length || diagnosis.hypotheses.length ? (
        <div className="issue-findings-block">
          <h3>What remains uncertain</h3>
          {diagnosis.hypotheses.length ? (
            <p>Possible explanations remain unconfirmed.</p>
          ) : null}
          <ul className="issue-findings-constraints">
            {diagnosis.constraints.map((text) => (
              <li key={text}>
                {text ===
                'Quantities describe observed availability. Oversold orders, lost revenue and synchronization failure are not established.'
                  ? 'These observations do not confirm overselling, lost revenue, or a synchronization failure.'
                  : text}
              </li>
            ))}
          </ul>
          {diagnosis.hypotheses.length ? (
            <Disclosure className="issue-findings-causes">
              <summary>Possible causes · {diagnosis.hypotheses.length}</summary>
              {diagnosis.hypotheses.map((hypothesis) => (
                <div className="issue-findings-cause" key={hypothesis.code}>
                  <span className="case-caption">Unconfirmed</span>
                  <p>{hypothesis.text}</p>
                  {hypothesis.missingChecks.length ? (
                    <>
                      <h4>Checks needed</h4>
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
                      <h4>Contradicting evidence</h4>
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
          <summary>Potential impact</summary>
          <Facts facts={diagnosis.impact.potential} diagnosis={diagnosis} />
          <p className="case-caption">
            Potential impact does not establish realized losses.
          </p>
        </Disclosure>
      ) : null}
      <div className="issue-findings-footer">
        <h3>Sources</h3>
        <p className="case-caption">
          {evidence.length} evidence{' '}
          {evidence.length === 1 ? 'record' : 'records'} · Recorded freshness:{' '}
          {item.freshness}. Source update time may be unknown.
        </p>
        <IssueCollection
          title="Supporting evidence"
          noun="supporting evidence records"
          previewCount={0}
          triggerLabel="View supporting evidence"
          items={evidence}
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
            entries.map((entry) => (
              <Disclosure className="case-evidence" key={entry.id}>
                <summary>
                  {entry.source
                    ? `${entry.source.provider} · ${entry.source.resource}`
                    : 'Canonical evidence'}
                  <span>Observed {entry.observedAt}</span>
                </summary>
                <dl>
                  <dt>Evidence ID</dt>
                  <dd>{entry.id}</dd>
                  <dt>Observed</dt>
                  <dd>{entry.observedAt}</dd>
                  <dt>Source updated</dt>
                  <dd>{entry.sourceUpdatedAt ?? 'Unknown'}</dd>
                  {entry.source ? (
                    <>
                      <dt>Source object</dt>
                      <dd>{entry.source.externalId}</dd>
                      <dt>Source scope</dt>
                      <dd>{entry.source.scopeKey || 'Not specified'}</dd>
                    </>
                  ) : null}
                  <dt>Adapter</dt>
                  <dd>{entry.adapterVersion}</dd>
                  <dt>Schema</dt>
                  <dd>{entry.schemaVersion}</dd>
                </dl>
              </Disclosure>
            ))
          }
        />
        <Disclosure className="issue-findings-technical">
          <summary>Technical details</summary>
          <dl>
            <dt>Mapping versions</dt>
            <dd>
              {diagnosis.provenance.mappingVersions.join(', ') ||
                'Not recorded'}
            </dd>
            <dt>Configuration</dt>
            <dd>{diagnosis.provenance.configVersion}</dd>
            <dt>Rules</dt>
            <dd>{diagnosis.provenance.ruleVersion}</dd>
          </dl>
        </Disclosure>
      </div>
    </div>
  );
}
