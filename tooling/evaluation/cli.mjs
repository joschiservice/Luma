import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate } from './evaluate.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const options = {
  candidate: resolve(directory, 'fixtures/candidate.json'),
  corpus: resolve(directory, 'fixtures/corpus.json'),
  output: resolve('.luma/evaluations/playbook.json'),
};
try {
  const args = process.argv.slice(2);
  while (args.length) {
    const option = args.shift();
    const name = option?.slice(2);
    if (
      !option?.startsWith('--') ||
      !Object.hasOwn(options, name) ||
      !args[0] ||
      args[0].startsWith('--')
    )
      throw new Error(
        'Usage: pnpm evaluate:playbook [--candidate file] [--corpus file] [--output file]',
      );
    options[name] = resolve(args.shift());
  }
  const candidate = JSON.parse(await readFile(options.candidate, 'utf8'));
  const corpus = JSON.parse(await readFile(options.corpus, 'utf8'));
  const report = await evaluate(candidate, corpus);
  await mkdir(dirname(options.output), { recursive: true });
  const temporary = `${options.output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, options.output);
  for (const scenario of report.scenarios)
    console.log(
      `${scenario.passed ? 'PASS' : 'FAIL'} ${scenario.id}${scenario.failure ? `: ${scenario.failure}` : ''}`,
    );
  console.log(
    `${report.passed ? 'PASS' : 'FAIL'} ${report.playbook.hash}\nReport: ${options.output}`,
  );
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
