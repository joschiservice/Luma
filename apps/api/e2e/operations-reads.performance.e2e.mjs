// @ts-check
import { expect, it } from 'vitest';

import { performanceReport } from '../../../tooling/performance/report.mjs';
import { seedActivity } from './activity-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';
import { injectClient } from './typed-client.mjs';

// Sizes where a per-case or per-event scan of the tenant's rows spends seconds: each case would
// scan every inventory entity, and each event would scan every evidence row.
const inventoryEntities = 20_000;
const cases = 100;
const workflowRuns = 2_000;
const evidencePerCase = 40;
// `LUMA_ACTIVITY_BENCHMARK` names a larger event count for a size run, whose reads have no budget.
const sizeRun = Number(process.env.LUMA_ACTIVITY_BENCHMARK ?? 0);
const eventsPerCase = sizeRun ? Math.ceil(sizeRun / cases) : 50;

/**
 * Returns the fastest of three reads in milliseconds, which load on the machine can only raise.
 * @param {() => Promise<unknown>} read
 */
async function fastest(read) {
  const times = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    await read();
    times.push(performance.now() - start);
  }

  return Math.round(Math.min(...times));
}

// Each case document carries padding so PostgreSQL stores it out of line like a real one. A filter
// reading the document per scanned row then fetches it each time, which small documents hide.
it('reads the operations overview and activity within the interactive budget', async (t) => {
  const f = await settingsFixture(t);
  const tenantId = f.org.id;
  const { connectionId } = await seedActivity(f.db, tenantId, f.owner.id, 1);
  const issues = await f.db.owner.query(
    `WITH entities AS (
       INSERT INTO inventory_entities(tenant_id,id,kind,reconciliation_key)
       SELECT $1::uuid,gen_random_uuid(),'sku','sku-'||n FROM generate_series(1,$2::int) n
       RETURNING id
     ), subjects AS (SELECT id,row_number() OVER () AS n FROM entities)
     INSERT INTO exceptions(id,tenant_id,fingerprint,state,document)
     SELECT id,$1::uuid,fingerprint,'detected',jsonb_build_object(
       'id',id,'tenantId',$1::uuid::text,'fingerprint',fingerprint,'state','detected','exceptionClass','workflow_failure',
       'severity','high','firstDetectedAt',now(),'lastDetectedAt',now(),'occurrenceCount',1,'previousExceptionId',NULL,
       'ruleVersion','v0.1','configVersion','v0.1','context',padding,
       'subject',jsonb_build_object('ruleIdentity','benchmark','subjectKind','sku','subjectId',subject,'scope','[]'::jsonb))
     FROM (SELECT gen_random_uuid() AS id,s.id::text AS subject,md5(s.id::text)||md5(s.n::text) AS fingerprint,
       (SELECT string_agg(md5(s.id::text||n),'') FROM generate_series(1,200) n) AS padding
       FROM subjects s WHERE s.n<=$3) c
     RETURNING id,fingerprint`,
    [tenantId, inventoryEntities, cases],
  );
  await f.db.owner.query(
    `WITH evidence AS (
       SELECT i.id,i.fingerprint,i.id||':'||n AS key FROM unnest($2::uuid[],$3::text[]) i(id,fingerprint),generate_series(1,$4::int) n
     ), sources AS (
       INSERT INTO exception_sources(tenant_id,evidence_key,document)
       SELECT $1::uuid,'source:'||key,jsonb_build_object('tenantId',$1::uuid::text,'key','source:'||key,'connectionId',$5::text) FROM evidence
     ), inputs AS (
       INSERT INTO exception_inputs(tenant_id,evidence_key,document)
       SELECT $1::uuid,'input:'||key,jsonb_build_object('facts',jsonb_build_object('evidenceRefs',jsonb_build_array('source:'||key))) FROM evidence
       RETURNING evidence_key
     )
     INSERT INTO exception_evidence(tenant_id,exception_id,evidence_key,fingerprint)
     SELECT $1::uuid,e.id,i.evidence_key,e.fingerprint FROM evidence e JOIN inputs i ON i.evidence_key='input:'||e.key`,
    [
      tenantId,
      issues.rows.map((row) => row.id),
      issues.rows.map((row) => row.fingerprint),
      evidencePerCase,
      connectionId,
    ],
  );
  await f.db.owner.query(
    `INSERT INTO exception_outbox(id,tenant_id,exception_id,document,created_at)
     SELECT gen_random_uuid(),$1::uuid,i.id,jsonb_build_object('type','exception.observed','occurredAt',now()),
       now()-random()*interval '20 hours'
     FROM unnest($2::uuid[]) i(id),generate_series(1,$3::int)`,
    [tenantId, issues.rows.map((row) => row.id), eventsPerCase],
  );
  // Every event looks up its workflow run, so a per-event scan of the runs shows here too.
  await f.db.owner.query(
    `INSERT INTO workflow_trigger_runs(tenant_id,id,definition_id,version,version_digest,dedupe_key,request_digest,document,state)
     SELECT $1::uuid,r.id,v.definition_id,v.version,v.digest,r.id::text,'r',jsonb_build_object(
       'tenantId',$1::uuid::text,'id',r.id,'definitionId',v.definition_id,'version',v.version,'versionDigest',v.digest,
       'requestDigest','r','trigger',jsonb_build_object('kind','event')),'skipped'
     FROM playbook_versions v,(SELECT gen_random_uuid() AS id FROM generate_series(1,$2::int)) r WHERE v.tenant_id=$1::uuid`,
    [tenantId, workflowRuns],
  );
  await f.db.owner.query('ANALYZE');

  const client = injectClient(f.app, {
    origin: f.config.baseURL,
    cookie: f.owner.cookie,
  });
  const params = { organizationId: tenantId };
  const range = () => ({
    from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const readOverview = () =>
    client.operations.overview({ params, query: { window: '24h' } });
  const readActivity = () =>
    client.activity.list({
      params,
      query: { ...range(), view: 'business', detail: 'summary', limit: 30 },
    });

  // The workload reached the reads, and activity resolved connections through the evidence.
  expect((await readOverview()).activeCount).toBeGreaterThanOrEqual(cases);
  const page = await readActivity();
  expect(page.items).toHaveLength(30);
  const seeded = new Set(issues.rows.map((row) => row.id));
  const listed = page.items.filter((item) => seeded.has(item.exceptionId));
  expect(listed.length).toBeGreaterThan(0);
  for (const item of listed)
    expect(item.connections).toEqual([
      expect.objectContaining({ id: connectionId }),
    ]);

  await performanceReport(
    'operations-reads',
    {
      inventoryEntities,
      cases,
      workflowRuns,
      evidence: cases * evidencePerCase,
      events: cases * eventsPerCase,
      overviewReadMs: await fastest(readOverview),
      activityReadMs: await fastest(readActivity),
      feedReadMs: await fastest(() =>
        client.activity.list({
          params,
          query: { ...range(), view: 'business', detail: 'steps', limit: 30 },
        }),
      ),
      countsReadMs: await fastest(() =>
        client.activity.counts({ params, query: range() }),
      ),
    },
    sizeRun
      ? {}
      : { overviewReadMs: 500, activityReadMs: 700, feedReadMs: 700 },
  );
}, 300_000);
