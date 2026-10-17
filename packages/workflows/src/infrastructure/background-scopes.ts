import type { SqlTransaction } from '@luma/platform';

/**
 * A database connection outside tenant scope. Discovery runs through SECURITY DEFINER functions
 * that return routing identities only; work then reauthorizes in tenant scope.
 */
type DiscoveryConnection = Pick<SqlTransaction, 'query'>;

/** Principals with active case workflows to start. */
export async function listCaseWorkflowScopes(db: DiscoveryConnection) {
  return (
    await db.query<{ tenant_id: string; principal_id: string }>(
      'SELECT * FROM case_workflow_worker_scopes()',
    )
  ).rows.map((row) => ({
    tenantId: row.tenant_id,
    principalId: row.principal_id,
  }));
}

/** Principals and definitions with computation workflows to start. */
export async function listCodeProcessScopes(db: DiscoveryConnection) {
  return (
    await db.query<{
      tenant_id: string;
      principal_id: string;
      definition_id: string;
    }>('SELECT * FROM code_process_worker_scopes()')
  ).rows.map((row) => ({
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    definitionId: row.definition_id,
  }));
}

/** Moves up to 100 due scheduled runs across workspaces to awaiting admission, so they can start. */
export async function advanceWorkflowSchedules(db: DiscoveryConnection) {
  await db.query('SELECT advance_workflow_schedules()');
}
