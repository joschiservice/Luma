import { lstat, mkdir, mkdtemp, rename } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Archives pilot and simulator state after a database reset so the next launch reseeds.
 * Returns the backup directory, or null when there is no state to archive.
 */
export async function archiveDatabaseState(directory) {
  let backup;
  for (const name of ['pilot.json', 'simulator']) {
    try {
      await lstat(join(directory, name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      continue;
    }
    if (!backup) {
      const backups = join(directory, 'backups');
      await mkdir(backups, { recursive: true, mode: 0o700 });
      backup = await mkdtemp(join(backups, 'database-reset-'));
    }
    await rename(join(directory, name), join(backup, name));
  }

  return backup ?? null;
}
