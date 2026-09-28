export interface SqlTransaction {
  /** Executes parameterized SQL on the current transaction; values must not be interpolated into SQL. */
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface TenantDatabase {
  /** Runs with tenant isolation and commits on success. A rejected operation rolls back all its writes. readOnlySnapshot uses a repeatable-read snapshot established before tenant queries. */
  transaction<T>(
    tenantId: string,
    operation: (tx: SqlTransaction) => Promise<T>,
    options?: { readOnlySnapshot: true },
  ): Promise<T>;
}
