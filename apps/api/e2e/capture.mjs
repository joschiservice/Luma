import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The directory named by `LUMA_CAPTURE`, resolved from the checkout root, or undefined when
 * debug capture is off. Journeys write screenshots and measurements here only when it is set.
 * @returns {string | undefined}
 */
export function captureDirectory() {
  const setting = process.env.LUMA_CAPTURE;

  return setting ? resolve(checkout, setting) : undefined;
}

/**
 * Writes a JSON debug artefact, such as benchmark timings, into the capture directory. Does
 * nothing when `LUMA_CAPTURE` is unset. Returns the written path, if any.
 * @param {string} name file name inside the capture directory
 * @param {unknown} value
 * @returns {Promise<string | undefined>}
 */
export async function captureJson(name, value) {
  const directory = captureDirectory();
  if (!directory) return undefined;

  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

  return path;
}
