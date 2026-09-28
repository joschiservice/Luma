import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { evaluateCodeCorpus } from './code.mjs';

try {
  const source = resolve(
    process.argv[2] ?? 'tooling/evaluation/fixtures/code-corpus.json',
  );
  const output = resolve(process.argv[3] ?? '.luma/evaluations/code.json');
  const report = await evaluateCodeCorpus(
    JSON.parse(await readFile(source, 'utf8')),
    process.env.LUMA_CODE_RUNTIME_DIR ?? resolve('.luma/code-runtime'),
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  await rename(`${output}.tmp`, output);
  console.log(
    `${report.passed ? 'PASS' : 'FAIL'} ${report.artifactDigest}\nReport: ${output}`,
  );
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
