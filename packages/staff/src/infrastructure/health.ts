import type { PoolClient } from 'pg';

import type {
  AccessHistoryPage,
  StaffCount,
  StaffPerson,
  WorkspaceHealth,
} from '../application/health.js';
import {
  accessHistoryPageSize,
  healthCountCap,
  healthListLimit,
} from '../application/health.js';

// The staff_health_* views return rows only for the workspace of the transaction's valid support
// grant. Queries still name the workspace so each read uses the tenant's indexes directly.

const iso = (value: Date | null) => value?.toISOString() ?? null;

function bounded<T>(rows: T[], limit = healthListLimit) {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

function capped(count: number): StaffCount {
  return {
    count: Math.min(count, healthCountCap),
    capped: count > healthCountCap,
  };
}

function person(
  id: string,
  name: string | null,
  member: boolean | null,
): StaffPerson {
  return { id, name, member };
}

/** Reads every health section through the restricted staff views. Expects a validated grant. */
export async function readWorkspaceHealth(
  tx: PoolClient,
  workspaceId: string,
): Promise<WorkspaceHealth> {
  const list = healthListLimit + 1;
  const count = healthCountCap + 1;
  const query = async <Row extends object>(
    text: string,
    values = [] as unknown[],
  ) => (await tx.query<Row>(text, [workspaceId, ...values])).rows;

  const clock = await tx.query<{ now: Date }>(
    'SELECT clock_timestamp() AS now',
  );
  const [settings] = await query<{
    timezone: string;
    always_require_approval: boolean;
  }>(
    'SELECT timezone,always_require_approval FROM staff_health_settings WHERE tenant_id=$1',
  );
  const streams = bounded(
    await query<{
      id: string;
      connection_id: string;
      record_type: string;
      phase: string;
      scan: string | null;
      paused: boolean;
      blocked: string | null;
      attempts: number;
      error_code: string | null;
      error_message: string | null;
      error_at: Date | null;
      failing_since: Date | null;
      last_success_at: Date | null;
    }>(
      `SELECT id,connection_id,record_type,phase,scan,paused,blocked,attempts,error_code,error_message,error_at,failing_since,last_success_at
      FROM staff_health_sync_streams WHERE tenant_id=$1
      ORDER BY (paused OR blocked IS NOT NULL OR failing_since IS NOT NULL) DESC,failing_since NULLS LAST,record_type,id LIMIT $2`,
      [list],
    ),
  );
  const runs = bounded(
    await query<{
      id: string;
      connection_id: string;
      record_type: string;
      kind: string;
      trigger: string;
      outcome: string;
      started_at: Date;
      finished_at: Date | null;
      records: number;
      failed: number;
      errors: number;
    }>(
      `SELECT id,connection_id,record_type,kind,trigger,outcome,started_at,finished_at,records,failed,errors
      FROM staff_health_sync_runs WHERE tenant_id=$1 ORDER BY started_at DESC,id DESC LIMIT $2`,
      [list],
    ),
  );
  const connections = bounded(
    await query<{
      id: string;
      provider: string;
      status: string;
      version: number;
      credential_version: number | null;
    }>(
      'SELECT id,provider,status,version,credential_version FROM staff_health_connections WHERE tenant_id=$1 ORDER BY provider,id LIMIT $2',
      [list],
    ),
  );
  const events = bounded(
    await query<{
      connection_id: string;
      version: number;
      event: string;
      status: string;
      credential_version: number;
      actor_id: string;
      actor_name: string | null;
      actor_member: boolean | null;
      created_at: Date;
    }>(
      `SELECT connection_id,version,event,status,credential_version,actor_id,actor_name,actor_member,created_at
      FROM staff_health_connection_events WHERE tenant_id=$1 ORDER BY created_at DESC,connection_id,version DESC LIMIT $2`,
      [list],
    ),
  );
  const checks = bounded(
    await query<{
      connection_id: string;
      capability: string;
      succeeded: boolean;
      error_code: string | null;
      observed_at: Date;
    }>(
      `SELECT connection_id,capability,succeeded,error_code,observed_at FROM staff_health_read_checks
      WHERE tenant_id=$1 ORDER BY succeeded,observed_at DESC,connection_id,capability LIMIT $2`,
      [list],
    ),
  );
  const [executionCounts] = await query<{ unknown: number; failed: number }>(
    `SELECT (SELECT count(*)::int FROM (SELECT FROM staff_health_executions WHERE tenant_id=$1 AND state='unknown' LIMIT $2) x) AS unknown,
      (SELECT count(*)::int FROM (SELECT FROM staff_health_executions WHERE tenant_id=$1 AND state='failed' LIMIT $2) x) AS failed`,
    [count],
  );
  const actions = bounded(
    await query<{
      id: string;
      proposal_id: string;
      state: 'unknown' | 'failed';
      capability: string | null;
      connection_id: string | null;
      dispatch: string | null;
      business_outcome: string | null;
      updated_at: Date;
    }>(
      `SELECT id,proposal_id,state,capability,connection_id,dispatch,business_outcome,updated_at
      FROM staff_health_executions WHERE tenant_id=$1 ORDER BY updated_at DESC,id DESC LIMIT $2`,
      [list],
    ),
  );
  const failures = bounded(
    await query<{
      id: string;
      proposal_id: string;
      phase: string | null;
      code: string | null;
      retry: string | null;
      effect: string | null;
      created_at: Date;
    }>(
      `SELECT id,proposal_id,phase,code,retry,effect,created_at FROM staff_health_execution_failures
      WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,
      [list],
    ),
  );
  const steps = bounded(
    await query<{
      run_id: string;
      definition_id: string;
      step_id: string;
      kind: string | null;
      state: 'waiting' | 'failed' | 'inconclusive' | 'escalated';
      recorded_at: Date | null;
    }>(
      `SELECT run_id,definition_id,step_id,kind,state,recorded_at FROM staff_health_workflow_steps
      WHERE tenant_id=$1 ORDER BY sequence DESC LIMIT $2`,
      [list],
    ),
  );
  const [admissions] = await query<{ count: number; oldest: Date | null }>(
    `SELECT count(*)::int AS count,min(triggered_at) AS oldest FROM (
      SELECT triggered_at FROM staff_health_workflow_admissions WHERE tenant_id=$1 ORDER BY triggered_at NULLS LAST LIMIT $2) x`,
    [count],
  );
  const activations = bounded(
    await query<{
      id: string;
      definition_id: string;
      principal_id: string;
      principal_name: string | null;
      principal_member: boolean | null;
      created_at: Date;
    }>(
      `SELECT id,definition_id,principal_id,principal_name,principal_member,created_at FROM staff_health_case_activations
      WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT $2`,
      [list],
    ),
  );
  const cases = await query<{
    state: string;
    count: number;
    review_required: number;
  }>(
    `SELECT state,count(*)::int AS count,count(*) FILTER (WHERE review_required)::int AS review_required
    FROM staff_health_open_cases WHERE tenant_id=$1 GROUP BY state ORDER BY state`,
  );
  const [mailCount] = await query<{ count: number }>(
    'SELECT count(*)::int AS count FROM (SELECT FROM staff_health_failed_mail WHERE tenant_id=$1 LIMIT $2) x',
    [count],
  );
  const mail = bounded(
    await query<{
      id: string;
      kind: string;
      attempts: number;
      created_at: Date;
      first_attempt_at: Date | null;
    }>(
      `SELECT id,kind,attempts,created_at,first_attempt_at FROM staff_health_failed_mail
      WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,
      [list],
    ),
  );
  const apps = bounded(
    await query<{
      app_id: string;
      status: string;
      version: number;
      app_version: string | null;
      updated_at: Date;
    }>(
      'SELECT app_id,status,version,app_version,updated_at FROM staff_health_apps WHERE tenant_id=$1 ORDER BY app_id LIMIT $2',
      [list],
    ),
  );

  return {
    readAt: clock.rows[0]!.now.toISOString(),
    settings: settings
      ? {
          timezone: settings.timezone,
          alwaysRequireApproval: settings.always_require_approval,
        }
      : null,
    sync: {
      streams: streams.rows.map((row) => ({
        id: row.id,
        connectionId: row.connection_id,
        recordType: row.record_type,
        phase: row.phase,
        scan: row.scan,
        paused: row.paused,
        blocked: row.blocked,
        attempts: row.attempts,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        errorAt: iso(row.error_at),
        failingSince: iso(row.failing_since),
        lastSuccessAt: iso(row.last_success_at),
      })),
      streamsTruncated: streams.truncated,
      runs: runs.rows.map((row) => ({
        id: row.id,
        connectionId: row.connection_id,
        recordType: row.record_type,
        kind: row.kind,
        trigger: row.trigger,
        outcome: row.outcome,
        startedAt: row.started_at.toISOString(),
        finishedAt: iso(row.finished_at),
        records: row.records,
        failed: row.failed,
        errors: row.errors,
      })),
      runsTruncated: runs.truncated,
    },
    connections: {
      items: connections.rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        status: row.status,
        version: row.version,
        credentialVersion: row.credential_version,
      })),
      itemsTruncated: connections.truncated,
      events: events.rows.map((row) => ({
        connectionId: row.connection_id,
        version: row.version,
        event: row.event,
        status: row.status,
        credentialVersion: row.credential_version,
        actor: person(row.actor_id, row.actor_name, row.actor_member),
        createdAt: row.created_at.toISOString(),
      })),
      eventsTruncated: events.truncated,
      readChecks: checks.rows.map((row) => ({
        connectionId: row.connection_id,
        capability: row.capability,
        succeeded: row.succeeded,
        errorCode: row.error_code,
        observedAt: row.observed_at.toISOString(),
      })),
      readChecksTruncated: checks.truncated,
    },
    execution: {
      unknown: capped(executionCounts?.unknown ?? 0),
      failed: capped(executionCounts?.failed ?? 0),
      actions: actions.rows.map((row) => ({
        id: row.id,
        proposalId: row.proposal_id,
        state: row.state,
        capability: row.capability,
        connectionId: row.connection_id,
        dispatch: row.dispatch,
        businessOutcome: row.business_outcome,
        updatedAt: row.updated_at.toISOString(),
      })),
      actionsTruncated: actions.truncated,
      failures: failures.rows.map((row) => ({
        id: row.id,
        proposalId: row.proposal_id,
        phase: row.phase,
        code: row.code,
        retry: row.retry,
        effect: row.effect,
        createdAt: row.created_at.toISOString(),
      })),
      failuresTruncated: failures.truncated,
    },
    workflows: {
      steps: steps.rows.map((row) => ({
        runId: row.run_id,
        definitionId: row.definition_id,
        stepId: row.step_id,
        kind: row.kind,
        state: row.state,
        recordedAt: iso(row.recorded_at),
      })),
      stepsTruncated: steps.truncated,
      awaitingAdmission: {
        ...capped(admissions?.count ?? 0),
        oldestTriggeredAt: iso(admissions?.oldest ?? null),
      },
      activations: activations.rows.map((row) => ({
        id: row.id,
        definitionId: row.definition_id,
        principal: person(
          row.principal_id,
          row.principal_name,
          row.principal_member,
        ),
        createdAt: row.created_at.toISOString(),
      })),
      activationsTruncated: activations.truncated,
    },
    cases: {
      open: cases.reduce((total, row) => total + row.count, 0),
      byState: cases.map((row) => ({ state: row.state, count: row.count })),
      awaitingApproval:
        cases.find((row) => row.state === 'awaiting_approval')?.count ?? 0,
      reviewRequired: cases.reduce(
        (total, row) => total + row.review_required,
        0,
      ),
    },
    mail: {
      failed: capped(mailCount?.count ?? 0),
      items: mail.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        attempts: row.attempts,
        createdAt: row.created_at.toISOString(),
        firstAttemptAt: iso(row.first_attempt_at),
      })),
      itemsTruncated: mail.truncated,
    },
    apps: apps.rows.map((row) => ({
      appId: row.app_id,
      status: row.status,
      version: row.version,
      appVersion: row.app_version,
      updatedAt: row.updated_at.toISOString(),
    })),
    appsTruncated: apps.truncated,
  };
}

/**
 * Reads one page of access changes, newest first. `cursor` is a previous page's `nextCursor`:
 * the event time with microseconds and the event ID, which keeps paging stable on equal times.
 */
export async function readAccessHistory(
  tx: PoolClient,
  workspaceId: string,
  cursor: string | null,
): Promise<AccessHistoryPage> {
  const columns = `id,event_type,target_id,actor_id,actor_name,actor_member,subject_id,subject_name,subject_member,summary,created_at,cursor`;
  const position = cursor?.split('_');
  const result = await tx.query<{
    id: string;
    event_type: string;
    target_id: string;
    actor_id: string;
    actor_name: string | null;
    actor_member: boolean | null;
    subject_id: string | null;
    subject_name: string | null;
    subject_member: boolean | null;
    summary: string | null;
    created_at: Date;
    cursor: string;
  }>(
    position
      ? `SELECT ${columns} FROM staff_access_history WHERE tenant_id=$1 AND (created_at,id)<($3::timestamptz,$4::uuid)
        ORDER BY created_at DESC,id DESC LIMIT $2`
      : `SELECT ${columns} FROM staff_access_history WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,
    [workspaceId, accessHistoryPageSize + 1, ...(position ?? [])],
  );
  const page = result.rows.slice(0, accessHistoryPageSize);

  return {
    events: page.map((row) => ({
      id: row.id,
      type: row.event_type,
      targetId: row.target_id,
      actor: person(row.actor_id, row.actor_name, row.actor_member),
      subject: row.subject_id
        ? person(row.subject_id, row.subject_name, row.subject_member)
        : null,
      summary: row.summary,
      createdAt: row.created_at.toISOString(),
    })),
    nextCursor:
      result.rows.length > accessHistoryPageSize
        ? (page.at(-1)?.cursor ?? null)
        : null,
  };
}
