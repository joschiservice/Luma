import { expect, it } from 'vitest';

import { processSource } from '../../domain/process.fixture.js';
import { compileProcessWorkflow } from '../process-schema.js';
import { compileCodeSource } from './compiler.js';
import { checkCodeStep, defineCodeStep } from './schema.js';

const code = defineCodeStep({
  id: 'calculate',
  source: 'function main() { return { quantity: 2 }; }',
  fields: { quantity: 'number' },
  grants: [],
  limits: {
    fuel: 100000000,
    memoryBytes: 67108864,
    wallTimeMs: 5000,
    maxRequests: 1,
  },
});

it('binds source, limits, grants and return fields to the artifact', () => {
  for (const change of [
    { source: 'function main() { return {}; }' },
    { grants: ['refresh'] },
    { fields: {} },
    { limits: { ...code.limits, fuel: 10000 } },
  ])
    expect(() => checkCodeStep({ ...code, ...change })).toThrow(
      'digest mismatch',
    );
});

it('rejects imports, async entrypoints and missing main before publication', () => {
  for (const source of [
    'import x from "node:fs"; function main() {}',
    'async function main() {}',
    'const value = 3;',
    'export function main() {}',
  ])
    expect(() => compileCodeSource(source)).toThrow();
});

it('requires grants to own the immediately following published nodes', () => {
  const granted = defineCodeStep({ ...code, grants: ['refresh'] });
  const version = compileProcessWorkflow({
    ...processSource,
    steps: [granted, processSource.steps[0], processSource.steps.at(-1)],
  });
  expect(version.steps[0]!.kind).toBe('code');
  expect(() =>
    compileProcessWorkflow({
      ...processSource,
      steps: [granted, processSource.steps.at(-1)],
    }),
  ).toThrow('immediately following');
});

it('does not let conditions implicitly consume optional capability-owned reads', () => {
  const granted = defineCodeStep({ ...code, grants: ['refresh'] });
  expect(() =>
    compileProcessWorkflow({
      ...processSource,
      context: { ...processSource.context, fields: {} },
      steps: [
        granted,
        processSource.steps[0],
        processSource.steps[1],
        processSource.steps.at(-1),
      ],
    }),
  ).toThrow('declared context field');
});
