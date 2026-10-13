import { createHash, randomUUID } from 'node:crypto';

/** Seeds retained incident evidence and records assessments through the authenticated measurement API. */
export async function seedResolutionMeasurement(
  f,
  {
    synthetic = false,
    simulationConnection = false,
    environment = 'live',
    verified = true,
    previousIncidentId = null,
    detectedAt = new Date(Date.now() - 3600000).toISOString(),
    verifiedAt = new Date(Date.now() - 300000).toISOString(),
    sourceConnectionId = null,
  } = {},
) {
  const id = randomUUID(),
    evidence = `measurement:${randomUUID()}`;
  const tenant = f.org.id;
  const inputKey = `measurement-input:${randomUUID()}`;
  const connectionId = simulationConnection ? randomUUID() : sourceConnectionId;
  if (simulationConnection)
    await f.db.owner.query(
      'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
      [
        tenant,
        connectionId,
        {
          id: connectionId,
          tenantId: tenant,
          label: 'Provider fixture',
          target: {
            kind: 'jtl',
            baseUrl: 'https://jtl.synthetic.invalid/api/eazybusiness/',
          },
          status: 'active',
          version: 1,
          permissions: [],
          granted: [],
        },
        'fixture',
      ],
    );
  const fingerprint = createHash('sha256').update(id).digest('hex');
  const resolution = verified
    ? {
        kind: 'verification',
        at: verifiedAt,
        actorId: f.owner.id,
        auditId: randomUUID(),
        outcome: 'passed',
        authoritative: true,
        complete: true,
        evidenceRefs: [evidence],
        evaluatorVersion: 'fixture/1',
      }
    : undefined;
  const document = {
    id,
    tenantId: tenant,
    fingerprint,
    state: verified ? 'resolved' : 'verifying',
    exceptionClass: 'inventory_mismatch',
    severity: 'high',
    subject: {
      subjectKind: 'sku',
      subjectId: `SKU-${id.slice(0, 8)}`,
      scope: [],
    },
    firstDetectedAt: detectedAt,
    lastDetectedAt: detectedAt,
    occurrenceCount: 1,
    previousExceptionId: previousIncidentId,
    ruleVersion: 'v0.1',
    configVersion: 'fixture/1',
    resolution,
  };
  await f.db.owner.query(
    'INSERT INTO exceptions(tenant_id,id,fingerprint,state,previous_exception_id,document) VALUES($1,$2,$3,$4,$5,$6)',
    [tenant, id, fingerprint, document.state, previousIncidentId, document],
  );
  await f.db.owner.query(
    'INSERT INTO exception_sources(tenant_id,evidence_key,document) VALUES($1,$2,$3)',
    [
      tenant,
      evidence,
      {
        tenantId: tenant,
        key: evidence,
        observedAt: verifiedAt,
        adapterVersion: 'fixture/1',
        connectionId,
        facts: { synthetic },
      },
    ],
  );
  await f.db.owner.query(
    'INSERT INTO exception_inputs(tenant_id,evidence_key,document) VALUES($1,$2,$3)',
    [tenant, inputKey, { facts: { evidenceRefs: [evidence] } }],
  );
  await f.db.owner.query(
    'INSERT INTO exception_evidence(tenant_id,exception_id,fingerprint,evidence_key) VALUES($1,$2,$3,$4)',
    [tenant, id, fingerprint, inputKey],
  );
  const path = `${f.base}/exceptions/${id}/measurements`;
  let revision = 0;
  const record = async (fact) => {
    const event = await f.request(f.owner, path, 'POST', {
      id: randomUUID(),
      expectedRevision: revision,
      fact: { ...fact, evidenceRefs: [evidence] },
    });
    revision = event.revision;

    return event;
  };
  if (environment) await record({ kind: 'environment', environment });
  await record({
    kind: 'eligibility',
    status: 'eligible',
    ruleVersion: 'partner-rule/1',
    reasonCode: 'supported',
  });
  if (verified)
    await record({
      kind: 'attribution',
      involvement: 'none',
      complete: true,
      from: detectedAt,
      through: verifiedAt,
    });

  return {
    id,
    evidence,
    document,
    path,
    record,
    get revision() {
      return revision;
    },
    detectedAt,
    verifiedAt,
  };
}

/** Uses the shared registry to request live seven-day incident cohorts. */
export const resolutionMeasurementRequest = {
  definitionVersion: 2,
  metrics: [
    'resolution.eligible',
    'resolution.verified',
    'resolution.autonomous',
    'resolution.human',
    'resolution.unknown',
    'resolution.unknown_eligibility',
    'resolution.pending',
    'resolution.recurrent',
    'resolution.incorrect_actions',
    'resolution.time_to_outcome',
    'resolution.unresolved_age',
  ],
  scope: { environment: 'live', window: '7d' },
};
