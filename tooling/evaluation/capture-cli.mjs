import { readFile, writeFile } from 'node:fs/promises';

import { captureIncident } from './capture.mjs';

try {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length)
    throw new Error('Usage: pnpm capture:incident input.json corpus.json');
  const corpus = captureIncident(JSON.parse(await readFile(input, 'utf8')));
  await writeFile(output, `${JSON.stringify(corpus, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(`Captured ${corpus.scenarios[0].id}: ${output}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
