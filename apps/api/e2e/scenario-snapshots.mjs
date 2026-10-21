import { createHash } from 'node:crypto';

import { Client } from 'pg';

const templatePattern = /^e2e_template_([0-9a-f]{32})$/;

/** The name prefix of every scenario snapshot that belongs to the run's migrated template. */
const runPrefix = (template) => `snap_${templatePattern.exec(template)[1]}_`;

/** Serializes plain option values with sorted object keys, so equal scenarios share a key. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;

  return JSON.stringify(value) ?? 'null';
}

/**
 * How long a snapshot serves new journeys. Its workspace holds wall-clock observation times
 * and sync watermarks from preparation, while the copied simulator clock stays where it
 * stopped. Journeys must see that state about as fresh as after their own import: stock
 * older than five minutes is stale, and change reads overlap the last read by ten minutes.
 * An older snapshot is prepared again.
 */
const snapshotMaxAgeMs = 2 * 60_000;

/**
 * Names one scenario's snapshots, or returns `null` when the run has no migrated template to
 * derive the name from. `scenario` must hold every plain value that changes the seeded and
 * imported state; equal values share snapshots within the run. Names start with the run's
 * template token, so runs on a shared cluster never collide.
 */
export function scenarioName(scenario) {
  const template = process.env.LUMA_E2E_TEMPLATE_DATABASE;
  if (!process.env.TEST_DATABASE_URL || !templatePattern.test(template ?? ''))
    return null;

  return `${runPrefix(template)}${createHash('sha256')
    .update(canonical(scenario))
    .digest('hex')
    .slice(0, 12)}`;
}

/** The databases and roles of one prepared generation of a scenario. */
const generationNames = (scenario, generation) => ({
  template: process.env.LUMA_E2E_TEMPLATE_DATABASE,
  /** Luma's database, copied from the run's migrated template. */
  luma: `${scenario}_${generation}_l`,
  /** The restricted login the workspace was prepared with; dropped once prepared. */
  runtime: `${scenario}_${generation}_r`,
  /** The simulator database and its runtime role, which copies keep using. */
  simulator: `${scenario}_${generation}_s`,
});

const quote = (name) => `"${name}"`;

async function dropSnapshot(admin, names) {
  for (const database of [names.luma, names.simulator])
    await admin.query(
      `DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`,
    );
  for (const role of [names.runtime, names.simulator])
    await admin.query(`DROP ROLE IF EXISTS ${quote(role)}`);
}

/**
 * Returns the names and stored description of a current snapshot of `scenario`, preparing a
 * new generation when the run has none younger than two minutes. A PostgreSQL advisory lock
 * keyed by the scenario serializes preparation across worker processes; later callers wait
 * and reuse the result. `prepare(names)` must create the databases and roles in `names`,
 * close every connection to them and resolve to a JSON object the copies need. A failed
 * preparation is removed, so the next caller tries again. Prepared databases refuse
 * connections and serve only as `CREATE DATABASE` templates until the run's teardown, since
 * other journeys may still be copying an older generation.
 */
export async function preparedSnapshot(scenario, prepare) {
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock(hashtext($1))', [scenario]);
    // The description is written last, so its presence marks a complete generation.
    const { rows } = await admin.query(
      `SELECT substring(datname FROM '_([0-9]+)_l$')::int AS generation,
        shobj_description(oid, 'pg_database') AS description
      FROM pg_database WHERE starts_with(datname, $1) AND datname ~ '_[0-9]+_l$'
      ORDER BY generation DESC`,
      [`${scenario}_`],
    );
    const [latest] = rows;
    const stored = latest?.description ? JSON.parse(latest.description) : null;
    if (stored && Date.now() - stored.preparedAt < snapshotMaxAgeMs)
      return {
        names: generationNames(scenario, latest.generation),
        description: stored,
      };
    const names = generationNames(scenario, (latest?.generation ?? 0) + 1);
    // A process that stopped while preparing can leave an unmarked generation behind.
    if (latest && !stored)
      await dropSnapshot(admin, generationNames(scenario, latest.generation));
    try {
      // Observations are made during preparation; the snapshot is as old as its start.
      const preparedAt = Date.now();
      const description = { ...(await prepare(names)), preparedAt };
      // Copies get their own login. Dropping this one also proves that no object in the
      // prepared database belongs to it, which a copy's login could not use.
      await admin.query(`DROP ROLE ${quote(names.runtime)}`);
      for (const database of [names.luma, names.simulator])
        await admin.query(
          `ALTER DATABASE ${quote(database)} WITH ALLOW_CONNECTIONS false`,
        );
      const text = (
        await admin.query('SELECT quote_literal($1) AS value', [
          JSON.stringify(description),
        ])
      ).rows[0].value;
      await admin.query(`COMMENT ON DATABASE ${quote(names.luma)} IS ${text}`);

      return { names, description };
    } catch (error) {
      await dropSnapshot(admin, names).catch(() => undefined);
      throw error;
    }
  } finally {
    // Ending the session also releases the advisory lock.
    await admin.end();
  }
}

/**
 * Drops every scenario snapshot of the run whose migrated template is `template`, with its
 * roles. Runs in the global teardown, after each journey dropped its own copies.
 */
export async function dropScenarioSnapshots(admin, template) {
  if (!templatePattern.test(template)) return;
  const prefix = runPrefix(template);
  const databases = await admin.query(
    'SELECT datname FROM pg_database WHERE starts_with(datname, $1)',
    [prefix],
  );
  for (const { datname } of databases.rows)
    await admin.query(`DROP DATABASE IF EXISTS ${quote(datname)} WITH (FORCE)`);
  const roles = await admin.query(
    'SELECT rolname FROM pg_roles WHERE starts_with(rolname, $1)',
    [prefix],
  );
  for (const { rolname } of roles.rows)
    await admin.query(`DROP ROLE IF EXISTS ${quote(rolname)}`);
}
