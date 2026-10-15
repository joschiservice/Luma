import { randomUUID } from 'node:crypto';

import { seedPlaybooks } from './playbooks-fixture.mjs';

/** Seeds immutable producer records for history pagination and outcome checks. */
export async function seedActivity(
  db,
  tenantId,
  actorId,
  count = 35,
  separateEvents = false,
) {
  const { connectionId } = await seedPlaybooks(db, tenantId);
  const proposalId = randomUUID();
  const at = new Date().toISOString();
  const exceptionId = randomUUID();
  const incident = {
    id: exceptionId,
    tenantId,
    fingerprint: 'a'.repeat(64),
    state: 'detected',
    exceptionClass: 'workflow_failure',
    severity: 'high',
    subject: {
      ruleIdentity: 'workflow-step',
      subjectKind: 'workflow_run',
      subjectId: 'Order 1042',
      scope: ['shipping'],
    },
    firstDetectedAt: at,
    lastDetectedAt: at,
    occurrenceCount: 1,
    previousExceptionId: null,
    ruleVersion: 'v0.1',
    configVersion: 'v0.1',
  };
  await db.owner.query(
    "INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,'detected',$4)",
    [exceptionId, tenantId, incident.fingerprint, incident],
  );
  await db.owner.query(
    'INSERT INTO case_proposals(tenant_id,id,exception_id,diagnosis_revision,action_hash,document) VALUES($1,$2,$3,1,$4,$5)',
    [
      tenantId,
      proposalId,
      exceptionId,
      'b'.repeat(64),
      {
        id: proposalId,
        tenantId,
        connectionId,
        target: { kind: 'order', id: 'Order 1042' },
        capability: 'orders.shipping-method.write',
      },
    ],
  );
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    ids.push(id);
    let eventProposalId = proposalId;
    if (separateEvents && i > 0) {
      const eventIssueId = randomUUID();
      eventProposalId = randomUUID();
      const eventIncident = {
        ...incident,
        id: eventIssueId,
        fingerprint: randomUUID().replaceAll('-', '').padEnd(64, 'b'),
      };
      await db.owner.query(
        "INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,'detected',$4)",
        [eventIssueId, tenantId, eventIncident.fingerprint, eventIncident],
      );
      await db.owner.query(
        'INSERT INTO case_proposals(tenant_id,id,exception_id,diagnosis_revision,action_hash,document) VALUES($1,$2,$3,1,$4,$5)',
        [
          tenantId,
          eventProposalId,
          eventIssueId,
          'b'.repeat(64),
          {
            id: eventProposalId,
            tenantId,
            connectionId,
            target: { kind: 'order', id: `Order ${1042 + i}` },
            capability: 'orders.shipping-method.write',
          },
        ],
      );
    }
    const doc = {
      id,
      tenantId,
      eventKey: id,
      eventType: i === 0 ? 'policy.approved' : 'execution.completed',
      occurredAt: at,
      actor: { kind: 'user', id: actorId },
      connectionId,
      proposalId: eventProposalId,
      details:
        i === 0
          ? { outcome: 'approved' }
          : {
              state: i % 2 ? 'succeeded' : 'unknown',
              dispatch: 'dispatched',
              verification: i % 2 ? 'passed' : 'inconclusive',
            },
      evidenceRefs: ['observation:shipping-1042'],
      secret: 'must-not-appear',
    };
    await db.owner.query(
      'INSERT INTO audit_entries(id,tenant_id,event_key,proposal_id,document,created_at) VALUES($1::uuid,$2,$1::text,$3,$4,$5)',
      [id, tenantId, eventProposalId, doc, at],
    );
  }
  await db.owner.query(
    "INSERT INTO connector_lifecycle_events(tenant_id,connection_id,version,event,actor_id,status,credential_version) VALUES($1,$2,1,'connected',$3,'active',1)",
    [tenantId, connectionId, actorId],
  );

  return { ids, connectionId, proposalId, exceptionId, at };
}
