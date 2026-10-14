import { readRegionConfig } from '@luma/config';
import { Pool } from 'pg';

// Only a migration principal may initialize the immutable cell record.
const { region } = readRegionConfig(process.env);
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error('MIGRATION_DATABASE_URL is required');
const pool = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
  max: 1,
});
try {
  await pool.query('SELECT luma_provision_cell_region($1)', [region]);
  console.log('Cell region provisioned.');
} finally {
  await pool.end();
}
