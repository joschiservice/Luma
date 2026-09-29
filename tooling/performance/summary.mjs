import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { reportDirectory } from './report.mjs';

let files = [];
try {
  files = await readdir(reportDirectory);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const rows = [
  '## Performance budgets',
  '',
  '| Scenario | Metric | Measured | Maximum | Result |',
  '| --- | --- | ---: | ---: | --- |',
];
for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
  const report = JSON.parse(
    await readFile(join(reportDirectory, file), 'utf8'),
  );
  for (const [metric, maximum] of Object.entries(report.budgets)) {
    const value = report.measurements[metric];
    rows.push(
      `| ${report.name} | ${metric} | ${value} | ${maximum} | ${Number.isFinite(value) && value >= 0 && value <= maximum ? 'Pass' : 'Fail'} |`,
    );
  }
}
if (files.length) {
  const summary = `${rows.join('\n')}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
