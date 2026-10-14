import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
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
      dataRegion: 'AU',
    },
    builtInMembership(
      { id: 'membership', organizationId: tenant, userId: 'operator' },
      'owner',
    ),
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
    await owner.query('SELECT luma_provision_cell_region($1)', ['AU']);
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
    subject?: { kind: string; id: string },
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
          ...(subject ? { subject } : {}),
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

      expected['governed operation with an explicit order subject'] =
        await audit(
          client,
          await admissionStep(
            client,
            randomUUID(),
            { kind: 'starshipit_order_update', id: randomUUID() },
            { kind: 'order', id: orderRefs[0]! },
          ),
          '2026-09-07T01:00:00Z',
        );

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
        await audit(
          client,
          await admissionStep(
            client,
            randomUUID(),
            { kind: 'starshipit_order_update', id: randomUUID() },
            { kind: 'order', id: 'OTHER-ORDER' },
          ),
          '2026-09-11T01:00:00Z',
        ),
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
    expect(
      linked.items.find(
        (item) =>
          item.id ===
          expected['governed operation with an explicit order subject'],
      )?.resource,
    ).toBe(orderRefs[0]);

    const all = await store.list(context, window);
    expect(all.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        ...Object.values(expected),
        ...unrelated.slice(0, -1),
      ]),
    );
    expect(all.items).toHaveLength(
      Object.keys(expected).length + unrelated.length - 1,
    );

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

  it('names current and former members without reading other workspaces', async () => {
    const workspace = randomUUID();
    const neighbour = randomUUID();
    const people = {
      ada: randomUUID(),
      ben: randomUUID(),
      cleo: randomUUID(),
      dora: randomUUID(),
    };
    const at = (day: number) =>
      `2026-08-${String(day).padStart(2, '0')}T00:00:00Z`;
    const events: Record<string, string> = {};
    const client = await owner.connect();
    try {
      for (const id of [workspace, neighbour])
        await client.query(
          "INSERT INTO organizations(data_region,id,name,slug,created_at) VALUES('AU',$1,'People',$2,now())",
          [id, `people-${id}`],
        );
      for (const [key, id] of Object.entries(people))
        await client.query(
          'INSERT INTO users(id,name,email,created_at,updated_at) VALUES($1,$2,$3,now(),now())',
          [id, `${key} original`, `${key}@example.test`],
        );
      const join = (tenantId: string, userId: string) =>
        client.query(
          "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'member',now())",
          [randomUUID(), tenantId, userId],
        );
      await join(workspace, people.ada);
      await join(workspace, people.ben);
      await join(workspace, people.cleo);
      await join(neighbour, people.dora);
      // Ada's rename reaches the directory; Ben left first and keeps the name he had then.
      await client.query(
        'DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',
        [workspace, people.ben],
      );
      await client.query(
        "UPDATE users SET name=CASE id WHEN $1::uuid THEN 'Ada Lovelace' ELSE 'Ben Renamed' END WHERE id IN ($1::uuid,$2::uuid)",
        [people.ada, people.ben],
      );
      await client.query('DELETE FROM users WHERE id=$1', [people.cleo]);

      const record = async (
        key: string,
        actor: { kind: string; id: string } | null,
        day: number,
        correlationId?: string,
      ) => {
        const id = randomUUID();
        await client.query(
          'INSERT INTO audit_entries(id,tenant_id,event_key,proposal_id,document,created_at) VALUES($1::uuid,$2,$1::text,$3,$4,$5)',
          [
            id,
            workspace,
            randomUUID(),
            {
              id,
              tenantId: workspace,
              eventType: 'execution.dispatched',
              ...(actor ? { actor } : {}),
              ...(correlationId ? { correlationId } : {}),
            },
            at(day),
          ],
        );
        events[key] = id;
      };
      await record('ada', { kind: 'user', id: people.ada }, 1);
      await record('ben', { kind: 'user', id: people.ben }, 2);
      await record('cleo', { kind: 'user', id: people.cleo }, 3);
      await record('dora', { kind: 'user', id: people.dora }, 4);
      await record('service', { kind: 'service', id: 'luma.procurement' }, 5);
      await record('unrecorded', null, 6);

      // Reads ignore foreign keys, so the issue and workflow fixtures skip their parent chains.
      await client.query("SET session_replication_role='replica'");
      const detected = randomUUID();
      await client.query(
        'INSERT INTO exception_outbox(id,tenant_id,exception_id,document,created_at) VALUES($1,$2,$3,$4,$5)',
        [
          detected,
          workspace,
          randomUUID(),
          { type: 'exception.detected' },
          at(7),
        ],
      );
      events.detected = detected;
      const access = randomUUID();
      await client.query(
        "INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id,after_value,created_at) VALUES($1,$2::uuid,$3,'workspace.updated',$2::text,'{}',$4)",
        [access, workspace, people.ben, at(9)],
      );
      events.access = `access:${access}`;

      const digest = 'd'.repeat(64);
      await client.query(
        "INSERT INTO playbook_versions(tenant_id,definition_id,version,digest,document) VALUES($1,'replenish','1',$2,$3)",
        [
          workspace,
          digest,
          {
            definition: { id: 'replenish', name: 'Replenish low stock' },
            version: '1',
            digest,
          },
        ],
      );
      const runId = randomUUID();
      await client.query(
        "INSERT INTO workflow_trigger_runs(tenant_id,id,definition_id,version,version_digest,dedupe_key,request_digest,document,state) VALUES($1,$2::uuid,'replenish','1',$3,$2::text,'r',$4,'awaiting_admission')",
        [
          workspace,
          runId,
          digest,
          {
            tenantId: workspace,
            id: runId,
            definitionId: 'replenish',
            version: '1',
            versionDigest: digest,
            requestDigest: 'r',
            trigger: { kind: 'event' },
          },
        ],
      );
      await record('workflow', { kind: 'user', id: people.ada }, 8, runId);
    } finally {
      await client.query("SET session_replication_role='origin'");
      client.release();
    }

    let queries = 0;
    const database = createTenantDatabase(reader);
    const store = createActivityStore({
      transaction: (tenantId, operation, options) =>
        database.transaction(
          tenantId,
          (tx) =>
            operation(
              Object.assign(Object.create(tx) as typeof tx, {
                query: (...args: Parameters<typeof tx.query>) => {
                  queries++;

                  return tx.query(...args);
                },
              }),
            ),
          options,
        ),
    });
    const scoped = { ...context, tenantId: workspace };
    const range = { from: at(1), to: '2026-09-01T00:00:00Z' };
    const page = await store.list(scoped, { ...range, limit: 100 });
    const actor = (key: string) =>
      page.items.find((item) => item.id === events[key])?.actor;

    expect(actor('ada')).toEqual({
      kind: 'member',
      id: people.ada,
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      workflow: null,
    });
    expect(actor('ben')).toMatchObject({
      kind: 'former_member',
      name: 'ben original',
      email: null,
    });
    expect(actor('cleo')).toMatchObject({
      kind: 'former_member',
      name: 'cleo original',
      email: null,
    });
    // Dora belongs to another workspace, so her name stays there.
    expect(actor('dora')).toMatchObject({
      kind: 'former_member',
      id: people.dora,
      name: null,
    });
    expect(actor('service')).toMatchObject({
      kind: 'service',
      name: 'luma.procurement',
    });
    expect(actor('unrecorded')).toMatchObject({
      kind: 'unrecorded',
      name: null,
    });
    expect(actor('detected')).toMatchObject({ kind: 'luma', id: null });
    expect(actor('access')).toMatchObject({
      kind: 'former_member',
      name: 'ben original',
    });
    expect(actor('workflow')).toMatchObject({
      kind: 'member',
      name: 'Ada Lovelace',
      workflow: { id: 'replenish', name: 'Replenish low stock' },
    });

    const search = async (q: string) =>
      (await store.list(scoped, { ...range, limit: 100, q })).items.map(
        (item) => item.id,
      );
    expect(await search('LOVELACE')).toEqual([events.workflow, events.ada]);
    expect(await search('ada@example')).toEqual([events.workflow, events.ada]);
    expect(await search('ben original')).toEqual([events.access, events.ben]);
    expect(await search('dora original')).toEqual([]);
    expect(await search('replenish low')).toEqual([events.workflow]);

    // The actor filter matches the attribution the row shows and never widens visibility.
    const byActor = async (actor: string[], reader = scoped) =>
      (await store.list(reader, { ...range, limit: 100, actor })).items.map(
        (item) => item.id,
      );
    expect(await byActor([people.ada])).toEqual([events.workflow, events.ada]);
    expect(await byActor([people.ben])).toEqual([events.access, events.ben]);
    expect(await byActor([people.dora])).toEqual([events.dora]);
    expect(await byActor(['luma'])).toEqual([events.detected]);
    expect(await byActor(['workflow'])).toEqual([events.workflow]);
    expect(await byActor(['luma', people.ben])).toEqual([
      events.access,
      events.detected,
      events.ben,
    ]);
    expect(await byActor([randomUUID()])).toEqual([]);
    // Service identifiers are not people, even when a filter names them.
    expect(await byActor(['luma.procurement'])).toEqual([]);
    const member = {
      ...makeTenantContext(
        { userId: people.ada, sessionId: 'member-session' },
        {
          id: workspace,
          name: 'People',
          slug: `people-${workspace}`,
          status: 'active',
          dataRegion: 'AU',
        },
        builtInMembership(
          {
            id: 'member-membership',
            organizationId: workspace,
            userId: people.ada,
          },
          'member',
        ),
        randomUUID(),
      ),
      tenantId: workspace,
    };
    expect(await byActor([people.ben], member)).toEqual([events.ben]);
    // A page link belongs to the actor filter it was read with.
    const firstOfAda = await store.list(scoped, {
      ...range,
      limit: 1,
      actor: [people.ada],
    });
    expect(firstOfAda.nextCursor).toBeTruthy();
    await expect(
      store.list(scoped, {
        ...range,
        limit: 1,
        actor: [people.ben],
        cursor: firstOfAda.nextCursor!,
      }),
    ).rejects.toThrow(/no longer matches/);

    queries = 0;
    await store.list(scoped, { ...range, limit: 1 });
    const small = queries;
    queries = 0;
    await store.list(scoped, { ...range, limit: 100 });
    expect(queries).toBe(small);
  }, 60000);
});
