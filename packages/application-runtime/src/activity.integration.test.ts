import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { makeTenantContext } from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { createActivityStore } from '@luma/resolution/composition';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Workspace activity on PostgreSQL', () => {
  const name = `activity_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  let owner: Pool, reader: Pool;
  const tenant = randomUUID();
  const orderRefs = [randomUUID(), 'gid://shopify/Order/7001'];
  const window = {
    from: '2026-01-01T00:00:00Z',
    to: '2026-10-01T00:00:00Z',
    limit: 100,
  };

  const context = makeTenantContext(
    { userId: 'operator', sessionId: 'session' },
    {
      id: tenant,
      name: 'Fixture',
      slug: 'fixture',
      status: 'active',
      dataRegion: 'EU',
    },
    {
      id: 'membership',
      organizationId: tenant,
      userId: 'operator',
      role: 'owner',
    },
    randomUUID(),
  );

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    owner = new Pool({ connectionString: url.toString() });
    const setup = await admin.connect();
    try {
      await setup.query(
        "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
      );
      for (const file of (
        await readdir(new URL('../migrations/', import.meta.url))
      ).sort())
        if (file.endsWith('.sql'))
          await owner.query(
            await readFile(
              new URL(`../migrations/${file}`, import.meta.url),
              'utf8',
            ),
          );
    } finally {
      await setup.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
      setup.release();
    }
    // The reader mirrors the API login, so row-level security applies to every read.
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${name}_r" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(
      `GRANT luma_connectors,luma_case_reader,luma_desk TO "${name}_r"`,
    );
    url.username = `${name}_r`;
    url.password = password;
    reader = new Pool({ connectionString: url.toString() });
  });

  afterAll(async () => {
    await reader?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE IF EXISTS "${name}_r"`);
    await admin.end();
  });

  /** Inserts one audit event for a proposal, optionally correlated with a run. */
  async function audit(
    client: PoolClient,
    proposalId: string,
    at: string,
    correlationId?: string,
  ) {
    const id = randomUUID();
    await client.query(
      'INSERT INTO audit_entries(id,tenant_id,event_key,proposal_id,document,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        tenant,
        id,
        proposalId,
        {
          id,
          tenantId: tenant,
          eventType: 'execution.dispatched',
          ...(correlationId ? { correlationId } : {}),
        },
        at,
      ],
    );

    return id;
  }

  async function exception(
    client: PoolClient,
    subject: { subjectKind: string; subjectId: string },
  ) {
    const id = randomUUID();
    const fingerprint = randomUUID().replaceAll('-', '').repeat(2);
    await client.query(
      "INSERT INTO exceptions(id,tenant_id,fingerprint,state,document) VALUES($1,$2,$3,'detected',$4)",
      [
        id,
        tenant,
        fingerprint,
        {
          id,
          tenantId: tenant,
          fingerprint,
          state: 'detected',
          exceptionClass: 'stuck_fulfillment',
          severity: 'high',
          occurrenceCount: 1,
          subject,
        },
      ],
    );

    return id;
  }

  async function exceptionEvent(
    client: PoolClient,
    exceptionId: string,
    at: string,
  ) {
    const id = randomUUID();
    await client.query(
      'INSERT INTO exception_outbox(id,tenant_id,exception_id,document,created_at) VALUES($1,$2,$3,$4,$5)',
      [id, tenant, exceptionId, { type: 'exception.detected' }, at],
    );

    return id;
  }

  async function caseCommand(
    client: PoolClient,
    exceptionId: string,
    proposalId: string,
    at: string,
  ) {
    const id = randomUUID();
    await client.query(
      "INSERT INTO case_commands(tenant_id,id,exception_id,actor_id,request,document,created_at) VALUES($1,$2,$3,'operator',$4,'{}',$5)",
      [tenant, id, exceptionId, { kind: 'approve', proposalId }, at],
    );

    return id;
  }

  async function caseProposal(
    client: PoolClient,
    exceptionId: string,
    target: { kind: string; id: string },
  ) {
    const id = randomUUID();
    await client.query(
      "INSERT INTO case_proposals(tenant_id,id,exception_id,diagnosis_revision,action_hash,document) VALUES($1,$2,$3,1,repeat('a',64),$4)",
      [tenant, id, exceptionId, { id, tenantId: tenant, target }],
    );

    return id;
  }

  async function playbookRun(
    client: PoolClient,
    document: { incidentId?: string; target: { kind: string; id: string } },
  ) {
    const id = randomUUID();
    await client.query(
      "INSERT INTO playbook_runs(tenant_id,id,activation_id,definition_id,version,version_digest,document) VALUES($1,$2,$2,'playbook','1','d',$3)",
      [
        tenant,
        id,
        {
          id,
          tenantId: tenant,
          activationId: id,
          definitionId: 'playbook',
          version: '1',
          versionDigest: 'd',
          ...(document.incidentId ? { incidentId: document.incidentId } : {}),
          action: { id, target: document.target },
        },
      ],
    );

    return id;
  }

  async function admissionStep(
    client: PoolClient,
    runId: string,
    target: { kind: string; id: string },
  ) {
    const proposalId = randomUUID();
    await client.query(
      "INSERT INTO action_admission_steps(tenant_id,run_id,step_id,proposal_id,artifact_id,artifact_version,document) VALUES($1,$2,'step',$3,'artifact','1',$4)",
      [
        tenant,
        runId,
        proposalId,
        {
          tenantId: tenant,
          runId,
          stepId: 'step',
          action: { id: proposalId, target },
        },
      ],
    );

    return proposalId;
  }

  async function triggerRun(client: PoolClient) {
    const id = randomUUID();
    await client.query(
      "INSERT INTO workflow_trigger_runs(tenant_id,id,definition_id,version,version_digest,dedupe_key,request_digest,document,state) VALUES($1,$2,'playbook','1','d',$4,'r',$3,'awaiting_admission')",
      [
        tenant,
        id,
        {
          tenantId: tenant,
          id,
          definitionId: 'playbook',
          version: '1',
          versionDigest: 'd',
          requestDigest: 'r',
          trigger: { kind: 'event' },
        },
        id,
      ],
    );

    return id;
  }

  it('keeps every event linked to an order through issues, runs and targets', async () => {
    const client = await owner.connect();
    const expected: Record<string, string> = {};
    const unrelated: string[] = [];
    let issueId: string, runId: string, playbookRunId: string;
    try {
      // Reads ignore foreign keys, so fixtures skip the full execution chain behind each event.
      await client.query("SET session_replication_role='replica'");
      const other = { kind: 'order', id: 'OTHER-1' };

      issueId = await exception(client, {
        subjectKind: 'fulfillment',
        subjectId: 'F-1',
      });
      expected['given issue'] = await exceptionEvent(
        client,
        issueId,
        '2026-09-01T00:00:00Z',
      );
      const issueProposal = await caseProposal(client, issueId, {
        kind: 'sku',
        id: 'S-1',
      });
      expected['proposal of given issue'] = await audit(
        client,
        issueProposal,
        '2026-09-02T00:00:00Z',
      );
      // Matches by issue and by proposal, and must still appear once.
      expected['command on given issue'] = await caseCommand(
        client,
        issueId,
        issueProposal,
        '2026-09-02T12:00:00Z',
      );
      expected['run of given issue'] = await audit(
        client,
        await playbookRun(client, {
          incidentId: issueId,
          target: { kind: 'sku', id: 'S-1' },
        }),
        '2026-09-03T00:00:00Z',
      );

      const orderIssue = await exception(client, {
        subjectKind: 'order',
        subjectId: orderRefs[1]!,
      });
      expected['issue about the order'] = await exceptionEvent(
        client,
        orderIssue,
        '2026-09-04T00:00:00Z',
      );
      const otherIssue = await exception(client, {
        subjectKind: 'order',
        subjectId: 'OTHER-1',
      });
      expected['proposal targeting the order'] = await audit(
        client,
        await caseProposal(client, otherIssue, {
          kind: 'order',
          id: orderRefs[0]!,
        }),
        '2026-09-05T00:00:00Z',
      );
      expected['run targeting the order'] = await audit(
        client,
        await playbookRun(client, {
          target: { kind: 'order', id: orderRefs[1]! },
        }),
        '2026-09-06T00:00:00Z',
      );
      const policyId = randomUUID();
      await client.query(
        'INSERT INTO policy_outbox(id,tenant_id,document,created_at) VALUES($1,$2,$3,$4)',
        [
          policyId,
          tenant,
          {
            type: 'policy.evaluated',
            document: {
              proposalId: await admissionStep(client, randomUUID(), {
                kind: 'order',
                id: orderRefs[0]!,
              }),
              outcome: 'allow',
            },
          },
          '2026-09-07T00:00:00Z',
        ],
      );
      expected['admission step targeting the order'] = policyId;

      playbookRunId = await playbookRun(client, { target: other });
      expected['event of a given run'] = await audit(
        client,
        playbookRunId,
        '2026-09-07T12:00:00Z',
      );
      runId = await triggerRun(client);
      expected['event correlated with a run'] = await audit(
        client,
        randomUUID(),
        '2026-09-08T00:00:00Z',
        runId,
      );
      const stepProposal = await admissionStep(client, runId, other);
      expected['admission step of a run'] = await audit(
        client,
        stepProposal,
        '2026-09-09T00:00:00Z',
      );
      expected['command on a run proposal'] = await caseCommand(
        client,
        otherIssue,
        stepProposal,
        '2026-09-10T00:00:00Z',
      );

      unrelated.push(
        await exceptionEvent(client, otherIssue, '2026-09-11T00:00:00Z'),
        await audit(
          client,
          await playbookRun(client, { target: other }),
          '2026-09-12T00:00:00Z',
        ),
        await audit(client, randomUUID(), '2026-09-13T00:00:00Z', randomUUID()),
      );
      // Events outside the window stay out even when they are linked.
      unrelated.push(
        await exceptionEvent(client, issueId, '2025-12-31T00:00:00Z'),
      );
    } finally {
      await client.query("SET session_replication_role='origin'");
      client.release();
    }

    const store = createActivityStore(createTenantDatabase(reader));
    const linked = await store.list(context, {
      ...window,
      subjects: {
        issueIds: [issueId],
        runIds: [runId, playbookRunId],
        orderRefs,
      },
    });
    expect(
      Object.fromEntries(
        Object.entries(expected).filter(
          ([, id]) => !linked.items.some((item) => item.id === id),
        ),
      ),
    ).toEqual({});
    expect(linked.items).toHaveLength(Object.keys(expected).length);

    const all = await store.list(context, window);
    expect(all.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        ...Object.values(expected),
        ...unrelated.slice(0, 3),
      ]),
    );
    expect(all.items).toHaveLength(Object.keys(expected).length + 3);

    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list(context, {
        ...window,
        limit: 4,
        cursor,
        subjects: {
          issueIds: [issueId],
          runIds: [runId, playbookRunId],
          orderRefs,
        },
      });
      paged.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(paged).toEqual(linked.items.map((item) => item.id));

    const none = await store.list(context, {
      ...window,
      subjects: { issueIds: ['not-a-uuid'], runIds: [], orderRefs: [] },
    });
    expect(none.items).toEqual([]);
  }, 60000);
});
