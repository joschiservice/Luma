import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ESLint } from 'eslint';
import { format, resolveConfig } from 'prettier';

const filePath = 'apps/api/src/composition/style-fixture.ts';

test('exported functions need descriptions but local helpers do not', async () => {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(
    `
function local() { return 1; }

export function undocumented() { return local(); }

/** Returns the helper result. */
export const documented = () => local();
`,
    { filePath },
  );
  assert.equal(
    result.messages.filter(
      (message) => message.ruleId === 'jsdoc/require-jsdoc',
    ).length,
    1,
  );
  const [empty] = await eslint.lintText(
    '/** */\nexport function empty() { return 1; }',
    { filePath },
  );
  assert.ok(
    empty.messages.some(
      (message) => message.ruleId === 'jsdoc/require-description',
    ),
  );
});

test('autofix never fabricates function documentation', async () => {
  const [result] = await new ESLint({ fix: true }).lintText(
    'export function undocumented() { return 1; }',
    { filePath },
  );
  assert.ok(
    result.messages.some((message) => message.ruleId === 'jsdoc/require-jsdoc'),
  );
  assert.ok(!result.output?.includes('/**'));
});

test('spacing and import fixes remain valid after Prettier formats TypeScript', async () => {
  const code = `import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
export interface Example { id: string; }
/** Creates an example with a random identifier. */
export function createExample(): Example {
  const id = basename(randomUUID());
  return { id };
}`;
  const [fixed] = await new ESLint({ fix: true }).lintText(code, { filePath });
  assert.equal(fixed.errorCount, 0);
  const formatted = await format(fixed.output ?? code, {
    ...(await resolveConfig(filePath)),
    parser: 'typescript',
  });
  const [checked] = await new ESLint({ fix: true }).lintText(formatted, {
    filePath,
  });
  assert.equal(checked.errorCount, 0);
  assert.equal(checked.output, undefined);
  assert.ok(formatted.indexOf('node:crypto') < formatted.indexOf('node:path'));
  assert.match(formatted, /;\n\nexport interface/);
  assert.match(formatted, /;\n\n\s+return/);
});

test('imports must precede declarations and duplicate imports are rejected', async () => {
  const [result] = await new ESLint().lintText(
    `
export const first = 1;
import { randomUUID } from 'node:crypto';
import { randomBytes } from 'node:crypto';
export const values = [randomUUID(), randomBytes(1)];
`,
    { filePath },
  );
  assert.ok(
    result.messages.some(
      (message) => message.ruleId === 'no-restricted-syntax',
    ),
  );
  assert.ok(
    result.messages.some(
      (message) => message.ruleId === 'no-duplicate-imports',
    ),
  );
});
