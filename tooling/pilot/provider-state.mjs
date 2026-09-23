import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

const recentEntries = 200;

/** Updates synthetic provider state across pilot processes and keeps recent diagnostic records. */
export async function mutateProviderState(pool, path, operation) {
  const client = await pool.connect();
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let discardClient = false;

  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [path],
    );
    const state = JSON.parse(await readFile(path, 'utf8'));
    const result = operation(state);

    for (const key of ['observations', 'capabilityEvents']) {
      if (state[key]?.length > recentEntries)
        state[key] = state[key].slice(-recentEntries);
    }

    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
      flush: true,
    });
    await rename(temporaryPath, path);
    await client.query('COMMIT');

    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardClient = true;
    }
    await unlink(temporaryPath).catch((cleanupError) => {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  } finally {
    client.release(discardClient);
  }
}
