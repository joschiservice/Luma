import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { seed } from '../../../tooling/dev/seed.mjs';
import { database, secret } from './helpers.mjs';

test('repeated demo seeding preserves evaluations, diagnoses and evidence', async (t) => {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const role = new URL(db.runtimeUrl).username;
  await db.owner.query(`GRANT luma_exceptions TO "${role}"`);
  const directory = await mkdtemp(join(tmpdir(), 'luma-seed-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const saved = { seedPassword: randomUUID() };
  const env = {
    IDENTITY_DATABASE_URL: db.runtimeUrl,
    WORKFLOW_DATABASE_URL: db.runtimeUrl,
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: 'http://127.0.0.1:3000',
  };

  async function snapshot() {
    const result = {};
    for (const table of [
      'users',
      'organizations',
      'memberships',
      'exceptions',
      'exception_configurations',
      'exception_sources',
      'exception_inputs',
      'exception_evidence',
      'exception_evaluations',
      'exception_outbox',
      'exception_diagnosis_heads',
      'exception_diagnoses',
    ]) {
      result[table] = (
        await db.owner.query(
          `SELECT to_jsonb(row) AS value FROM ${table} row ORDER BY to_jsonb(row)::text`,
        )
      ).rows.map((row) => row.value);
    }

    return result;
  }

  await seed(saved, env, directory);
  const initial = await snapshot();
  expect(initial.users).toHaveLength(1);
  expect(initial.organizations).toHaveLength(1);
  expect(initial.exceptions).toHaveLength(2);
  expect(initial.exception_evaluations).toHaveLength(2);
  expect(initial.exception_diagnoses).toHaveLength(2);
  const credentials = await readFile(join(directory, 'demo.json'), 'utf8');
  // Completion is determined by persisted evidence, not a local output file.
  await rm(join(directory, 'demo.json'));
  for (let attempt = 0; attempt < 2; attempt++) {
    await seed(saved, env, directory);
    expect(await snapshot()).toEqual(initial);
    expect(await readFile(join(directory, 'demo.json'), 'utf8')).toBe(
      credentials,
    );
  }
});
