import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const journeys = fileURLToPath(new URL('../../apps/api/e2e/', import.meta.url));
// Journeys written before type checking; remove an entry when its journey gains `// @ts-check`.
const unchecked = JSON.parse(
  readFileSync(new URL('unchecked-journeys.json', import.meta.url), 'utf8'),
);

/** Lists backend and browser journeys with whether their first line opts in to type checking. */
function journeyFiles() {
  return readdirSync(journeys)
    .filter((name) => /\.(e2e|browser)\.mjs$/.test(name))
    .sort()
    .map((name) => ({
      name,
      checked: readFileSync(join(journeys, name), 'utf8').startsWith(
        '// @ts-check\n',
      ),
    }));
}

test('new journeys opt in to type checking', () => {
  const allowed = new Set(unchecked);
  assert.deepEqual(
    journeyFiles()
      .filter(({ name, checked }) => !checked && !allowed.has(name))
      .map(({ name }) => name),
    [],
    'Start these journeys with `// @ts-check` and call the API through e2e/typed-client.mjs',
  );
});

test('the unchecked journey baseline only shrinks', () => {
  const files = new Map(
    journeyFiles().map(({ name, checked }) => [name, checked]),
  );
  assert.deepEqual(
    unchecked.filter((name) => files.get(name) !== false),
    [],
    'Remove deleted or type-checked journeys from tooling/architecture/unchecked-journeys.json',
  );
  assert.deepEqual(unchecked, [...new Set(unchecked)].sort());
});
