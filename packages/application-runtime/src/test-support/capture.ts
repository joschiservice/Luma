import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The checkout root: the nearest directory above this module with the pnpm workspace file. */
function checkoutRoot() {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'pnpm-workspace.yaml'))) {
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error('No pnpm workspace above capture.ts');
    directory = parent;
  }

  return directory;
}

/**
 * Writes a JSON debug artefact, such as benchmark timings or query plans, into the directory
 * named by `LUMA_CAPTURE`, resolved from the checkout root. Does nothing when the variable is
 * unset, so ordinary runs leave no files behind. Returns the written path, if any.
 */
export async function captureJson(name: string, value: unknown) {
  const setting = process.env.LUMA_CAPTURE;
  if (!setting) return undefined;

  const directory = resolve(checkoutRoot(), setting);
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

  return path;
}
