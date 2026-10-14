import type { DataRegion } from '@luma/config';
import type { Pool } from 'pg';

type CellDatabase = Pick<Pool, 'query'>;

/** Checks the immutable database placement before a process starts serving or loading work. */
export async function assertCellRegion(
  database: CellDatabase,
  region: DataRegion,
): Promise<void> {
  const result = await database.query<{ region: string }>(
    'SELECT region FROM luma_cell_region',
  );
  if (result.rows.length !== 1 || result.rows[0]?.region !== region)
    throw new Error(
      'LUMA_REGION differs from the provisioned database cell region.',
    );
}
