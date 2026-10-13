import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { evaluateRedTeam } from './red-team.mjs';

const usage =
  'Usage: node tooling/evaluation/red-team-cli.mjs baseline.json candidate.json corpus.json proposals.json report.json';

try {
  const paths = process.argv.slice(2);
  if (paths.length !== 5) throw new Error(usage);
  const [baseline, candidate, corpus, proposals] = await Promise.all(
    paths
      .slice(0, 4)
      .map(async (path) => JSON.parse(await readFile(resolve(path), 'utf8'))),
  );
  const report = await evaluateRedTeam(baseline, candidate, corpus, proposals);
  const output = resolve(paths[4]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(`${output}.tmp`, output);
  console.log(
    `${report.passed ? 'PASSED' : 'FAILED'}: ${report.counterexamples.length} counterexamples. Report: ${output}`,
  );
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : usage);
  process.exitCode = 1;
}
