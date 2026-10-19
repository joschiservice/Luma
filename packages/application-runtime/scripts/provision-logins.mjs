import { Pool } from 'pg';

import { provisionRuntimeLogins } from './runtime-logins.mjs';

// Deployments run this with migration credentials after migrations and region provisioning.
const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required');
const passwords = {
  luma_api: process.env.LUMA_API_DATABASE_PASSWORD,
  luma_worker: process.env.LUMA_WORKER_DATABASE_PASSWORD,
  luma_staff: process.env.LUMA_STAFF_DATABASE_PASSWORD,
};
for (const [name, password] of Object.entries(passwords))
  if (!password || password.length < 24)
    throw new Error(`The ${name} password must have at least 24 characters`);

const pool = new Pool({ connectionString, max: 1 });
const client = await pool.connect();
try {
  await provisionRuntimeLogins(
    client,
    /** @type {Record<keyof typeof passwords, string>} */ (passwords),
  );
  console.log('Runtime database logins provisioned.');
} finally {
  client.release();
  await pool.end();
}
