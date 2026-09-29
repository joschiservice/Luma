import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const reportDirectory = fileURLToPath(
  new URL('../../.luma/performance/', import.meta.url),
);

/** Writes measurements before rejecting exceeded or invalid numeric budgets. Limits are inclusive. */
export async function performanceReport(
  name,
  measurements,
  budgets = {},
  directory = reportDirectory,
) {
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error('Invalid performance report name');
  const violations = [];
  for (const [metric, maximum] of Object.entries(budgets)) {
    const value = measurements[metric];
    if (
      !Number.isFinite(maximum) ||
      maximum < 0 ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > maximum
    )
      violations.push(
        `${metric}: ${value} exceeds or is invalid for budget ${maximum}`,
      );
  }
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${name}.json`),
    `${JSON.stringify({ name, measurements, budgets, violations }, null, 2)}\n`,
  );
  if (violations.length)
    throw new Error(`Performance budget failed: ${violations.join('; ')}`);
}
