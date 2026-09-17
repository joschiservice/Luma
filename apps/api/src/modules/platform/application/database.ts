export interface SqlTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}
export interface TenantDatabase {
  transaction<T>(
    tenantId: string,
    operation: (tx: SqlTransaction) => Promise<T>,
  ): Promise<T>;
}
