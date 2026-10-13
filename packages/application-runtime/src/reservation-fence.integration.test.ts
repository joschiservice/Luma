import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase } from './test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('execution reservation fence', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let owner: Pool;

  beforeAll(async () => {
    database = await createMigratedDatabase(databaseUrl!);
    owner = database.owner;
  });

  afterAll(async () => {
    await database?.drop();
  });

  /** Creates a workspace that allows writes, with the given number of active members. */
  async function workspace(members: number) {
    const tenantId = randomUUID();
    await owner.query(
      "INSERT INTO organizations(id,name,slug,status,write_mode,created_at) VALUES($1,'Fence',$2,'active','writes_enabled',now())",
      [tenantId, `fence-${tenantId}`],
    );
    for (let index = 0; index < members; index++) {
      const userId = randomUUID();
      await owner.query(
        'INSERT INTO users(id,name,email,created_at,updated_at) VALUES($1,$2,$3,now(),now())',
        [userId, `Member ${index}`, `${userId}@example.test`],
      );
      await owner.query(
        "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",
        [randomUUID(), tenantId, userId],
      );
    }

    return tenantId;
  }

  /** Runs statements in one transaction, optionally in a workspace's context. */
  async function inContext<T>(
    tenantId: string | null,
    work: (client: PoolClient) => Promise<T>,
  ) {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      if (tenantId)
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [
          tenantId,
        ]);
      const result = await work(client);
      await client.query('COMMIT');

      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Records a policy decision and reserves its execution. */
  async function reserve(
    client: PoolClient,
    tenantId: string,
    policyVersion: string,
  ) {
    const proposalId = randomUUID();
    const decisionId = randomUUID();
    const hash = 'e'.repeat(64);
    await client.query(
      'INSERT INTO execution_intents(id,tenant_id,action_hash,document) VALUES($1,$2,$3,$4)',
      [proposalId, tenantId, hash, { id: proposalId, tenantId }],
    );
    await client.query(
      'INSERT INTO policy_decisions(id,tenant_id,proposal_id,action_hash,document) VALUES($1,$2,$3,$4,$5)',
      [
        decisionId,
        tenantId,
        proposalId,
        hash,
        {
          id: decisionId,
          tenantId,
          proposalId,
          outcome: 'allowed',
          policyVersion,
        },
      ],
    );
    const executionId = randomUUID();
    await client.query(
      "INSERT INTO executed_actions(id,tenant_id,proposal_id,idempotency_key,action_hash,state,document) VALUES($1,$2,$3,$4,$5,'prepared',$6)",
      [
        executionId,
        tenantId,
        proposalId,
        `v0:${proposalId}`,
        hash,
        {
          id: executionId,
          tenantId,
          proposalId,
          state: 'prepared',
          attempt: { policyDecisionId: decisionId },
        },
      ],
    );
  }

  it('binds reservations to the effective approval rule of the workspace', async () => {
    const solo = await workspace(1);
    await expect(
      inContext(solo, (client) => reserve(client, solo, 'v0.1:self-approval')),
    ).resolves.toBeUndefined();
    await expect(
      inContext(solo, (client) => reserve(client, solo, 'v0.1')),
    ).rejects.toThrow('Workspace policy changed before reservation');

    const team = await workspace(2);
    await expect(
      inContext(team, (client) => reserve(client, team, 'v0.1')),
    ).resolves.toBeUndefined();
    await expect(
      inContext(team, (client) => reserve(client, team, 'v0.1:self-approval')),
    ).rejects.toThrow('Workspace policy changed before reservation');
  });

  it('refuses reservations outside their workspace context', async () => {
    const solo = await workspace(1);
    const other = await workspace(2);
    await expect(
      inContext(null, (client) => reserve(client, solo, 'v0.1:self-approval')),
    ).rejects.toThrow('Reservation requires its workspace context');
    await expect(
      inContext(other, (client) => reserve(client, solo, 'v0.1:self-approval')),
    ).rejects.toThrow('Reservation requires its workspace context');
  });
  it('includes persisted enrollment epochs and retains the solo self-response preference', async () => {
    const solo = await workspace(1);
    await owner.query(
      'INSERT INTO autonomy_epochs(tenant_id,revision) VALUES($1,2)',
      [solo],
    );
    await expect(
      inContext(solo, (client) =>
        reserve(client, solo, 'v0.1:self-approval:autonomy:2'),
      ),
    ).resolves.toBeUndefined();
    await expect(
      inContext(solo, (client) => reserve(client, solo, 'v0.1:self-approval')),
    ).rejects.toThrow('Workspace policy changed before reservation');
    await expect(
      inContext(solo, (client) =>
        reserve(client, solo, 'v0.1:self-approval:autonomy:1'),
      ),
    ).rejects.toThrow('Workspace policy changed before reservation');
    const id = randomUUID(),
      actorId = randomUUID();
    await inContext(solo, (client) =>
      client.query(
        'INSERT INTO policy_approvals(id,tenant_id,proposal_id,action_hash,policy_version,document) VALUES($1,$2,$3,$4,$5,$6)',
        [
          id,
          solo,
          randomUUID(),
          'a'.repeat(64),
          'v0.1:self-approval:autonomy:2',
          {
            id,
            tenantId: solo,
            outcome: 'approved',
            approverId: actorId,
            requesterId: actorId,
          },
        ],
      ),
    );
  });
});
