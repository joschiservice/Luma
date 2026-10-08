import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { root } from '../dev/process.mjs';
import { cssFindings } from './ui-policy.mjs';

const baseline = JSON.parse(
  await readFile(new URL('./ui-baseline.json', import.meta.url), 'utf8'),
);
const roots = ['apps/web/src', 'apps/staff/src', 'packages/apps'];
let failures = 0;
const remaining = new Set(Object.keys(baseline));
for (const directory of roots) {
  for (const entry of await readdir(join(root, directory), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.css') ||
      entry.parentPath.includes('node_modules')
    )
      continue;
    const path = join(entry.parentPath, entry.name);
    const file = relative(root, path).replaceAll('\\', '/');
    if (
      directory === 'packages/apps' &&
      !/^packages\/apps\/[^/]+\/src\//.test(file)
    )
      continue;
    remaining.delete(file);
    const allowed = { ...baseline[file]?.findings };
    for (const finding of cssFindings(await readFile(path, 'utf8'), file)) {
      if (allowed[finding.signature] > 0) allowed[finding.signature]--;
      else {
        console.error(
          `${file}:${finding.line} ${finding.signature}; use shared tokens or component variants.`,
        );
        failures++;
      }
    }
    for (const [signature, count] of Object.entries(allowed)) {
      if (!count) continue;
      console.error(`${file}: remove resolved baseline entry: ${signature}`);
      failures++;
    }
  }
}
for (const file of remaining) {
  console.error(
    `${file}: remove baseline for a file outside the checked source tree.`,
  );
  failures++;
}
if (failures) process.exitCode = 1;
else console.log('UI CSS policy passed.');
